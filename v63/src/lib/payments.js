import { supabase } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// ---------- Naira formatting ----------
// Inkroot's payment system runs in Naira (see supabase/history/32_migration_naira_payments.sql)
// — published_books.price and every amount here is a plain Naira number, converted to kobo only
// at the edge (right before it's sent to Paystack, and right after it comes back from a query
// that stores kobo).
export function formatNaira(amountNaira) {
    if (!amountNaira || amountNaira <= 0) return 'Free';
    return `\u20a6${Number(amountNaira).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

// formatNaira above prints "Free" for a zero amount — right for a book price, wrong for a balance
// or earnings figure: a writer with nothing to withdraw saw "Available balance: Free", and a
// balance pushed below zero by a refund or chargeback (author_balance_kobo() can go negative once
// a sale that was already withdrawn is refunded) also read "Free". Used for every balance/earnings
// display instead: always a real amount, with a minus sign when it's genuinely negative.
export function formatNairaBalance(amountNaira) {
    const n = Number(amountNaira) || 0;
    return `${n < 0 ? '-' : ''}\u20a6${Math.abs(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export function koboToNaira(amountKobo) {
    return Math.round(amountKobo) / 100;
}

// ---------- Timeouts (production-readiness audit, failure-recovery findings #9 and #8) ----------
// Before this, nothing on a money path had a deadline: a request that hung (a dead connection
// that never errors, a stalled edge function) left the Buy / Pay / Withdraw button spinning
// forever, and the pollers below could not honour their own 20 s cutoff because their deadline
// was only checked *between* requests, never during one. withTimeout() gives every such call an
// upper bound. It only stops *waiting* — it cannot un-send the request, so for a money call the
// request may well have gone through. That is why the messages below never invite a blind
// retry: they tell the person to check first.
//
// Exported (and reused by guild-events.js) so there is one timer helper, not one per file. The
// timer is always cleared, and a late result from the losing side of the race is ignored — the
// race has already attached handlers to it, so it cannot surface as an unhandled rejection.
// The timeout error carries `isTimeout` so a poller can tell "that one request was slow" (keep
// polling until its own deadline) from a real failure (let it propagate as before).
export function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            const err = new Error(message);
            err.isTimeout = true;
            reject(err);
        }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const REQUEST_TIMEOUT_MS = 30000; // one edge-function call
export const POLL_REQUEST_TIMEOUT_MS = 8000; // one status read inside a settle-poller

// Shown when an edge-function call outlasts REQUEST_TIMEOUT_MS. Deliberately says the request
// may still have completed — for checkout init, a withdrawal or a bank-account save the server
// may have acted even though the answer never arrived.
const REQUEST_TIMEOUT_MESSAGE = 'This is taking longer than expected. Your request may still have gone through — check before trying again.';

// Shown when the Paystack popup is closed without a success callback. Audit finding #8: the old
// text said the payment was "cancelled", which is untrue for a bank transfer — the popup can be
// closed while the transfer is still on its way and confirms later, so a reader who believed
// "cancelled" would pay a second time. Exported for guild-events.js's two popup flows.
export const PAYMENT_WINDOW_CLOSED_MESSAGE = 'Payment window closed. If you paid by bank transfer it may still confirm — check before paying again.';

// Exported so other real-money flows outside this file (guild-events.js's event-entry checkout)
// can reuse the exact same edge-function error unwrapping instead of a second copy of it.
export async function invoke(name, body) {
    const { data, error } = await withTimeout(supabase.functions.invoke(name, { body }), REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MESSAGE);
    if (error) {
        // supabase-js only gives a generic error for a non-2xx response — the function's own
        // { error: "..." } body (via jsonResponse in _shared/payments.ts, itself built from
        // sanitizeError() on the Edge Function side) is what actually explains what went wrong,
        // so surface that when it's there. If it isn't (a network failure before the function
        // even ran, a malformed response), fall back to sanitizeError() rather than the raw
        // client-side error.message, which was never guaranteed to be safe to show.
        const detail = await error.context?.json?.().catch(() => null);
        if (detail?.error) throw new Error(detail.error);
        throw sanitizeError(error);
    }
    if (data?.error) throw new Error(data.error);
    return data;
}

// ---------- Checkout (readers paying for a book or tipping an author) ----------

let paystackScriptPromise = null;
// Exported for the same reason as invoke() above — one script loader, not one per checkout flow.
export function loadPaystackScript() {
    if (window.PaystackPop) return Promise.resolve();
    if (!paystackScriptPromise) {
        paystackScriptPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://js.paystack.co/v2/inline.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Could not load Paystack — check your connection.'));
            document.head.appendChild(script);
        });
    }
    return paystackScriptPromise;
}

// Polls the purchases row for `reference` until the webhook (see
// supabase/functions/paystack-webhook) flips it to success/failed, or timeoutMs runs out.
// Paystack's own popup already confirmed the charge to the browser by the time this runs — this
// is just waiting for Inkroot's own record of it to catch up, which is normally near-instant.
//
// Each read is itself bounded (POLL_REQUEST_TIMEOUT_MS) so a hung request can't hold the loop
// past its deadline; a slow read counts as "not settled yet" and the loop simply carries on.
async function waitForPurchaseSettled(reference, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { data } = await withTimeout(
            supabase.from('purchases').select('status').eq('paystack_reference', reference).single(),
            POLL_REQUEST_TIMEOUT_MS, 'Status check timed out',
        ).catch((e) => { if (e.isTimeout) return { data: null }; throw e; });
        if (data && data.status !== 'pending') return data.status;
        await new Promise((r) => setTimeout(r, 1500));
    }
    return 'pending'; // webhook hasn't landed yet — caller shows "still processing" rather than failing
}

// kind: 'book' | 'tip'. amountNaira only matters for a tip (a book's price is looked up
// server-side from published_books, never trusted from here). Returns the final status:
// 'success' | 'failed' | 'pending' (pending meaning "Paystack confirmed it, Inkroot's own record
// hasn't caught up yet — will settle shortly").
export async function checkoutBook({ bookId, kind, amountNaira }) {
    await loadPaystackScript();
    const init = await invoke('paystack-init-purchase', { kind, bookId, amountNaira });
    const outcome = await new Promise((resolve, reject) => {
        const popup = new window.PaystackPop();
        popup.resumeTransaction(init.accessCode, {
            onSuccess: () => resolve('confirmed'),
            onCancel: () => reject(new Error(PAYMENT_WINDOW_CLOSED_MESSAGE)),
            onError: (err) => reject(new Error(err?.message || 'Payment failed')),
        });
    });
    if (outcome !== 'confirmed') return 'failed';
    return waitForPurchaseSettled(init.reference);
}

// Same idea as checkoutBook above, for a Worldbuilding Pack (fix-tracker item 20) — a pack's
// price is looked up server-side from published_packs, never trusted from here, same as a
// book's. Diverges from checkoutBook in one place: a free pack's init call comes back
// `{ free: true }` instead of a Paystack access code (see paystack-init-pack-purchase — Paystack
// itself won't process a zero-amount charge), so the popup is skipped entirely rather than ever
// being shown for a pack that already has its settled purchases row.
export async function checkoutPack({ packId }) {
    const init = await invoke('paystack-init-pack-purchase', { packId });
    if (init.free) return 'success';
    await loadPaystackScript();
    const outcome = await new Promise((resolve, reject) => {
        const popup = new window.PaystackPop();
        popup.resumeTransaction(init.accessCode, {
            onSuccess: () => resolve('confirmed'),
            onCancel: () => reject(new Error(PAYMENT_WINDOW_CLOSED_MESSAGE)),
            onError: (err) => reject(new Error(err?.message || 'Payment failed')),
        });
    });
    if (outcome !== 'confirmed') return 'failed';
    return waitForPurchaseSettled(init.reference);
}

// ---------- Saved bank accounts ----------

export async function fetchBanks() {
    const data = await invoke('paystack-banks', {});
    return data.banks;
}

export async function resolveBankAccount({ accountNumber, bankCode }) {
    const data = await invoke('paystack-resolve-account', { accountNumber, bankCode });
    return data.accountName;
}

export async function saveBankAccount({ accountNumber, bankCode, makeDefault }) {
    const data = await invoke('paystack-save-bank-account', { accountNumber, bankCode, makeDefault });
    return data.bankAccount;
}

export async function fetchSavedBankAccounts() {
    const { data, error } = await supabase.from('bank_accounts').select('*').order('is_default', { ascending: false }).order('created_at', { ascending: false });
    if (error) throw sanitizeError(error);
    return data || [];
}

export async function deleteBankAccount(id) {
    const { error } = await supabase.from('bank_accounts').delete().eq('id', id);
    if (error) {
        // Postgres 23503 (foreign_key_violation): withdrawals.bank_account_id references
        // bank_accounts with `on delete restrict` — deliberately, so a paid-out withdrawal never
        // loses the record of where the money went. sanitizeError() would flatten this to the
        // generic "Something went wrong", which reads as a bug and invites retrying something that
        // can never work (audit finding #24). No SQL change: the restriction is intentional; the
        // person just needs to be told why and what to do instead.
        if (error.code === '23503') {
            console.warn('Inkroot: bank account has withdrawal history and cannot be deleted', error);
            throw new Error("This account has withdrawal history and can't be removed. Add another account and make it your default.");
        }
        throw sanitizeError(error);
    }
}

export async function setDefaultBankAccount(id) {
    const { error } = await supabase.rpc('set_default_bank_account', { target_account_id: id });
    if (error) throw sanitizeError(error);
}

// ---------- Earnings & withdrawals ----------

export async function fetchAvailableBalanceNaira() {
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user?.id;
    if (!userId) return 0;
    const { data, error } = await supabase.rpc('author_balance_kobo', { check_user_id: userId });
    if (error) throw sanitizeError(error);
    return koboToNaira(data || 0);
}

const PENDING_LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export async function fetchSalesLedger() {
    const { data, error } = await supabase.from('purchases').select('id, kind, book_id, amount_kobo, author_amount_kobo, status, created_at, paid_at')
        .order('created_at', { ascending: false }).limit(50);
    if (error) throw sanitizeError(error);
    // L1: a purchase that's still 'pending' after 24 hours is an abandoned checkout (popup closed,
    // card never charged), not a sale in progress — hide it so it doesn't sit in the ledger forever
    // looking like money that's about to arrive. Done client-side after the fetch on purpose: a
    // late charge.success (paystack-webhook, P3) flips the row to 'success' server-side, and it then
    // passes this filter and surfaces on the next load. Rows with an unparseable created_at are kept.
    const staleBefore = Date.now() - PENDING_LEDGER_MAX_AGE_MS;
    return (data || []).filter((row) => !(row.status === 'pending' && new Date(row.created_at).getTime() < staleBefore));
}

// Per-book Sales/Earnings for the Creator Dashboard's Published Books cards (CreatorBookCard).
// Deliberately NOT built from fetchSalesLedger() above: that function is capped at the 50 most
// recent purchases account-wide (right for a recent-activity ledger, the Earnings tab's own job),
// but a per-book lifetime total needs every row, not just the newest 50 — an author with more
// than 50 total purchases across their catalog would otherwise see silently undercounted numbers
// on their older/steadier-selling books. purchases' own RLS ("author reads sales of their own
// work", auth.uid() = author_id) already returns every row with no server-side cap, so this is a
// plain, uncapped, author-scoped query, aggregated client-side. Only real, paid book sales count
// (kind = 'book', status = 'success') — a tip isn't a book sale, and a pending/failed/refunded
// purchase isn't revenue (a later refund correctly drops a book back out of this: `refund.
// processed` in the webhook moves the row off 'success', so this simply stops counting it on the
// next fetch, same honesty the read-access check already has for a purchase that gets refunded).
// Returns a plain object keyed by book_id -> { sales, earningsKobo }; a book with no successful
// sales simply has no entry (callers should treat a missing key as zero, not as "not loaded yet"
// — check the surrounding loading state for that distinction instead).
export async function fetchBookSalesSummary() {
    const { data: session } = await supabase.auth.getSession();
    const userId = session.session?.user?.id;
    if (!userId) return {};
    const { data, error } = await supabase.from('purchases')
        .select('book_id, author_amount_kobo')
        .eq('author_id', userId).eq('kind', 'book').eq('status', 'success');
    if (error) throw sanitizeError(error);
    const byBook = {};
    for (const row of data || []) {
        if (!row.book_id) continue; // shouldn't happen for kind:'book', but never crash on a null fk
        const entry = byBook[row.book_id] || { sales: 0, earningsKobo: 0 };
        entry.sales += 1;
        entry.earningsKobo += row.author_amount_kobo || 0;
        byBook[row.book_id] = entry;
    }
    return byBook;
}

// paystack_transfer_code is included purely for display: once it's set, the transfer has
// actually been handed to Paystack (see paystack-withdraw), so a still-'pending' row with a
// transfer code is "in flight" rather than merely "requested" — see withdrawalStage() in
// creator-dashboard.jsx, which is the only place this field is read. Never used to gate any
// action here — the server-side status column is still the only source of truth for what a
// withdrawal actually is.
export async function fetchWithdrawals() {
    const { data, error } = await supabase.from('withdrawals').select('id, amount_kobo, status, failure_reason, created_at, completed_at, bank_account_id, paystack_transfer_code')
        .order('created_at', { ascending: false }).limit(50);
    if (error) throw sanitizeError(error);
    return data || [];
}

export async function requestWithdrawal({ bankAccountId, amountNaira }) {
    const data = await invoke('paystack-withdraw', { bankAccountId, amountNaira });
    return data.withdrawal;
}

// The manual-settlement sibling of requestWithdrawal — see manual-withdraw's own header comment
// for why this exists at all. Same shape, same client-side validation left to the server; the
// only difference from the caller's point of view is which Edge Function gets invoked.
//
// idempotencyKey (optional, migration 145): one key per logical withdrawal attempt. If the response
// to a request is lost and the caller retries with the SAME key, the server hands back the original
// withdrawal instead of creating a second one. Callers mint a new key only for a different request.
export async function requestManualWithdrawal({ bankAccountId, amountNaira, idempotencyKey }) {
    const data = await invoke('manual-withdraw', { bankAccountId, amountNaira, ...(idempotencyKey ? { idempotencyKey } : {}) });
    return data.withdrawal;
}

// Which withdrawal method WithdrawModal (creator-dashboard.jsx) actually uses today. A single
// switch rather than a per-call choice: Paystack Transfers need a business TIN Inkroot doesn't
// have yet, so every withdrawal goes through the manual queue for now (see
// 62_migration_manual_withdrawals.sql). Flip this back to 'paystack' once that's sorted —
// create_withdrawal_locked/paystack-withdraw/the webhook were never touched and still work
// exactly as before.
export const ACTIVE_WITHDRAWAL_METHOD = 'manual';

// The two admin-only calls behind the Manual Withdrawals admin queue (src/admin/
// manual-withdrawals-admin.jsx). Both are RPCs a signed-in admin's own client calls directly —
// see admin_list_pending_manual_withdrawals/admin_settle_manual_withdrawal's own comments in
// schema.sql for why these don't go through an Edge Function the way requestManualWithdrawal does.
export async function adminFetchPendingManualWithdrawals() {
    const { data, error } = await supabase.rpc('admin_list_pending_manual_withdrawals');
    if (error) throw sanitizeError(error);
    return data || [];
}

export async function adminSettleManualWithdrawal(withdrawalId, newStatus, note) {
    const { data, error } = await supabase.rpc('admin_settle_manual_withdrawal', {
        p_withdrawal_id: withdrawalId, p_new_status: newStatus, p_note: note || null,
    }).single();
    if (error) throw sanitizeError(error);
    return data;
}

