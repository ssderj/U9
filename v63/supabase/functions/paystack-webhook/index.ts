// The single source of truth for "did the money actually move". Paystack calls this URL
// directly (configure it in the Paystack dashboard, not from the app) for both transaction
// events (reader payments) and transfer events (author withdrawals). Every signature is
// verified against PAYSTACK_SECRET_KEY before anything in the request body is trusted — this is
// the one function that's allowed to flip a purchases/withdrawals row to success or failed;
// nothing else in the codebase does. Handles charge.success, charge.failed (production audit —
// a cancelled or declined checkout previously left its row 'pending' forever, since nothing
// here handled this event at all), transfer.success, transfer.failed/transfer.reversed, and
// refund.processed/charge.dispute.create.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Inlined from supabase/functions/_shared/payments.ts rather than imported: this function is
// deployed independently and the deploy path used doesn't reliably resolve cross-function
// relative imports. Keep this block identical to _shared/payments.ts if that file changes.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// Constant-time comparison — a plain `===` on two hex strings short-circuits at the first
// mismatched character, which leaks (via response timing) how many leading characters an
// attacker's guess got right. Both inputs here are fixed-length hex (SHA-512 HMAC, 128 chars),
// so walking the full length unconditionally costs nothing extra in the normal case, and closes
// that side channel for what is otherwise the only gate deciding whether a request gets to flip
// a purchases/withdrawals row to success.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(Deno.env.get('PAYSTACK_SECRET_KEY')!),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, signature);
}

// supabase-js never throws on a failed query — it resolves with `{ error }` instead. Without
// this check the try/catch below could never fire for a database failure, and every failed
// update was silently acknowledged to Paystack with a 200 (so Paystack never retried it). A query
// that runs fine but matches zero rows — an already-processed retry, or a reference that isn't
// ours — is NOT an error and is still acknowledged with 200; only a real failure throws here.
// A withdrawal is identified two ways: paystack_transfer_code (only written by paystack-withdraw
// AFTER Paystack's /transfer call returns, so a fast webhook -- or a failed code write -- can
// arrive before it exists) and the transfer `reference`, which paystack-withdraw sets to the
// withdrawal row's own id at creation. The reference is only used as a lookup when it really is a
// UUID: comparing a non-UUID string to the uuid `id` column raises a Postgres error, which would
// turn any transfer not made by this app into a permanent 5xx retry loop.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function withdrawalMatch(data: any): string | null {
  const clauses: string[] = [];
  if (typeof data?.transfer_code === 'string' && /^[A-Za-z0-9_-]+$/.test(data.transfer_code)) clauses.push(`paystack_transfer_code.eq.${data.transfer_code}`);
  if (typeof data?.reference === 'string' && UUID_RE.test(data.reference)) clauses.push(`id.eq.${data.reference}`);
  return clauses.length ? clauses.join(',') : null;
}

function assertOk(result: { error: { message: string } | null }, step: string) {
  if (result.error) throw new Error(`${step}: ${result.error.message}`);
}

// A greppable log line, plus a Telegram message when the same secrets manual-withdraw uses are
// set. Never throws and never affects the webhook's response: an alert that fails must not turn
// an already-handled money event into a 5xx (Paystack would retry it for hours).
async function alertOps(tag: string, detail: Record<string, unknown>) {
  console.error(tag, JSON.stringify(detail));
  try {
    const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
    const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `\u26a0\ufe0f ${tag}\n${JSON.stringify(detail)}` }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (alertErr) {
    console.error('paystack-webhook: alert delivery failed', String(alertErr));
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  // Fail closed if the secret isn't configured: TextEncoder().encode(undefined) would otherwise
  // sign with the literal string "undefined" as the HMAC key, which anyone could reproduce.
  // This is a server misconfiguration, not a bad request, so it's a 5xx.
  if (!Deno.env.get('PAYSTACK_SECRET_KEY')) {
    console.error('paystack-webhook: PAYSTACK_SECRET_KEY is not set');
    return new Response('Server error', { status: 500, headers: CORS_HEADERS });
  }

  const rawBody = await req.text();
  const valid = await verifySignature(rawBody, req.headers.get('x-paystack-signature'));
  if (!valid) return new Response('Invalid signature', { status: 401 });

  // A correctly-signed body that still isn't JSON can't be fixed by a retry, so it's a 400
  // rather than a 5xx.
  let event: any;
  try {
    event = JSON.parse(rawBody);
    if (!event || typeof event !== 'object') throw new Error('not an object');
  } catch {
    return new Response('Invalid payload', { status: 400, headers: CORS_HEADERS });
  }
  const db = serviceClient();

  try {
    if (event.event === 'charge.success') {
      const reference = event.data?.reference;
      // A charge reference belongs to exactly one of these three tables (paystack-init-purchase,
      // paystack-init-event-entry, and paystack-init-hosting-fee each mint their own mutually
      // exclusive prefix), so running all three updates is safe — whichever table doesn't have a
      // matching pending row just updates zero rows. All three are idempotent the same way:
      // Paystack may retry the same event, and a retry only ever matches a row that's still
      // 'pending', so it can never re-fire twice.
      //
      // If any one of these fails, the whole event returns 5xx and Paystack retries it: the ones
      // that already went through no longer match 'pending' on the retry, so they're no-ops and
      // only the still-pending row gets another attempt.
      if (reference) {
        const paidAt = new Date().toISOString();
        // purchases and hosting-fee payments accept a 'failed' row too: 'failed' is only ever set
        // by charge.failed (or an abandoned-checkout cleanup), and a later charge.success for the
        // same reference is Paystack telling us the money DID move — dropping it would leave the
        // payer charged with nothing granted. A guild event ENTRY is deliberately not widened: its
        // slot may already have been given to someone else, so that case alerts a human instead.
        const purchases: any = await db.from('purchases')
          .update({ status: 'success', paid_at: paidAt })
          .eq('paystack_reference', reference)
          .in('status', ['pending', 'failed'])
          .select('id, kind, buyer_id, book_id, pack_id');
        assertOk(purchases, 'charge.success purchases');
        // L4 (migration 146): an event ENTRY goes through apply_guild_event_entry_payment() so a
        // late payment (hold expired) can't take a slot past participant_limit. It returns
        // 'success' | 'over_limit' | 'already_applied' | 'not_pending' | 'unmatched'.
        const entryRes: any = await db.rpc('apply_guild_event_entry_payment', { p_reference: reference, p_paid_at: paidAt });
        assertOk(entryRes, 'charge.success guild_event_entries');
        const entryOutcome = entryRes.data;
        const entries: any = { data: entryOutcome === 'success' ? [{}] : [] };
        if (entryOutcome === 'over_limit') {
          // The row is now 'failed' (no slot) but the money DID move: a human refunds it. Counted as
          // handled below so the generic unmatched-success alert doesn't fire a second time.
          await alertOps('EVENT_ENTRY_OVER_LIMIT_REFUND', {
            reference, amount: event.data?.amount ?? null, currency: event.data?.currency ?? null,
          });
        }
        const fees: any = await db.from('guild_event_hosting_fee_payments')
          .update({ status: 'success', paid_at: paidAt })
          .eq('paystack_reference', reference)
          .in('status', ['pending', 'failed'])
          .select('id');
        assertOk(fees, 'charge.success guild_event_hosting_fee_payments');

        const matched = (purchases.data?.length ?? 0) + (entries.data?.length ?? 0) + (fees.data?.length ?? 0) + (entryOutcome === 'over_limit' ? 1 : 0);
        if (matched === 0) {
          // Normal for a retried delivery of an event we already applied (the row is 'success'
          // now). Anything else — an unknown reference, or a row that is 'refunded', or an entry
          // that was already failed/cancelled — means money moved and nothing was granted.
          //
          // guild_event_entries also matches 'failed' here, not just 'success': the only automated
          // writer of 'failed' on that table is apply_guild_event_entry_payment()'s over_limit
          // branch just above, which already alerted EVENT_ENTRY_OVER_LIMIT_REFUND for this exact
          // reference the first time it was seen. Without this, a Paystack retry of that same
          // delivery lands here with entryOutcome === 'not_pending' (matched stays 0, since only
          // 'success' bumps entries/matched), the row is 'failed' not 'success' so the check below
          // used to miss it, and the retry fired a second, wrongly-labeled PAYSTACK_UNMATCHED_SUCCESS
          // for money that was already handled and already alerted on. purchases/hosting-fee rows
          // don't need the same widening — their own update() above already accepts a 'failed' row
          // and flips it to 'success' on this pass, so a retry after that always finds 'success' via
          // the plain check; guild_event_entries is deliberately not widened *there* (a stale entry's
          // slot may have gone to someone else), which is exactly why 'failed' can survive here.
          const [p, e, h]: any[] = await Promise.all([
            db.from('purchases').select('id').eq('paystack_reference', reference).eq('status', 'success').limit(1),
            db.from('guild_event_entries').select('id').eq('paystack_reference', reference).in('status', ['success', 'failed']).limit(1),
            db.from('guild_event_hosting_fee_payments').select('id').eq('paystack_reference', reference).eq('status', 'success').limit(1),
          ]);
          if (p.error || e.error || h.error) {
            throw new Error(`charge.success lookup: ${(p.error || e.error || h.error).message}`);
          }
          const alreadyApplied = (p.data?.length ?? 0) + (e.data?.length ?? 0) + (h.data?.length ?? 0) > 0;
          if (!alreadyApplied) {
            await alertOps('PAYSTACK_UNMATCHED_SUCCESS', {
              reference, amount: event.data?.amount ?? null, currency: event.data?.currency ?? null,
            });
          }
        }

        // Audit hardening: the amount Paystack says was paid should equal what we expected for this
        // reference. ALERT-ONLY — it never blocks or undoes the grant above (a wrong guess here must
        // not strand a real payment); it just makes sure a human hears about a mismatch.
        try {
          const paid = event.data?.amount;
          if (typeof paid === 'number') {
            const [pm, em, hm]: any[] = await Promise.all([
              db.from('purchases').select('amount_kobo').eq('paystack_reference', reference).eq('status', 'success').limit(1),
              db.from('guild_event_entries').select('amount_kobo').eq('paystack_reference', reference).eq('status', 'success').limit(1),
              db.from('guild_event_hosting_fee_payments').select('fee_kobo').eq('paystack_reference', reference).eq('status', 'success').limit(1),
            ]);
            const expected = pm.data?.[0]?.amount_kobo ?? em.data?.[0]?.amount_kobo ?? hm.data?.[0]?.fee_kobo ?? null;
            const cur = event.data?.currency;
            if ((expected !== null && Number(expected) !== paid) || (typeof cur === 'string' && cur !== 'NGN')) {
              await alertOps('PAYSTACK_AMOUNT_MISMATCH', { reference, expected_kobo: expected, paid_kobo: paid, currency: cur ?? null });
            }
          }
        } catch (amtErr) {
          console.error('paystack-webhook: amount check failed', String(amtErr));
        }

        // A second successful charge for the same book/pack by the same buyer is a double charge.
        // Nothing is undone automatically — this only makes sure a human hears about it.
        try {
          for (const row of purchases.data ?? []) {
            if (row.kind !== 'book' && row.kind !== 'pack') continue;
            const col = row.kind === 'book' ? 'book_id' : 'pack_id';
            const itemId = row.kind === 'book' ? row.book_id : row.pack_id;
            if (!itemId) continue;
            const same: any = await db.from('purchases')
              .select('paystack_reference')
              .eq('buyer_id', row.buyer_id).eq('kind', row.kind).eq(col, itemId)
              .eq('status', 'success').gt('amount_kobo', 0);
            if (same.error) throw new Error(same.error.message);
            if ((same.data?.length ?? 0) > 1) {
              await alertOps('DUPLICATE_CHARGE', {
                buyer: row.buyer_id, kind: row.kind, item: itemId,
                references: same.data.map((r: any) => r.paystack_reference),
              });
            }
          }
        } catch (dupErr) {
          console.error('paystack-webhook: duplicate-charge check failed', String(dupErr));
        }
      }
    } else if (event.event === 'charge.failed') {
      // The charge failed outright (declined card, expired session) or the reader cancelled
      // Paystack's own checkout popup before finishing it — Paystack fires this event for both,
      // and until now nothing here ever handled it. The pending row it belongs to was previously
      // left 'pending' forever: harmless for a book purchase/tip (paystack-init-purchase has
      // never checked for an existing pending row before creating a fresh one on retry, so this
      // never locked a reader out — it just left permanently-dead rows with no way to tell
      // "abandoned" from "still mid-checkout" apart), but for a guild event entry or hosting-fee
      // payment it meant waiting out create_guild_event_entry_locked's own 30-minute abandonment
      // window (migration 104) before the slot/limit check stopped counting it, instead of being
      // marked failed the moment Paystack actually told us it failed. Same "safe to run all
      // three, whichever table doesn't match just updates zero rows" reasoning charge.success
      // above already relies on. Only a still-'pending' row is ever touched — an already-
      // 'success', 'failed', or 'refunded' row is left exactly alone.
      const reference = event.data?.reference;
      if (reference) {
        assertOk(await db.from('purchases')
          .update({ status: 'failed' })
          .eq('paystack_reference', reference)
          .eq('status', 'pending'), 'charge.failed purchases');
        assertOk(await db.from('guild_event_entries')
          .update({ status: 'failed' })
          .eq('paystack_reference', reference)
          .eq('status', 'pending'), 'charge.failed guild_event_entries');
        assertOk(await db.from('guild_event_hosting_fee_payments')
          .update({ status: 'failed' })
          .eq('paystack_reference', reference)
          .eq('status', 'pending'), 'charge.failed guild_event_hosting_fee_payments');
      }
    } else if (event.event === 'transfer.success') {
      const match = withdrawalMatch(event.data);
      if (match) {
        assertOk(await db.from('withdrawals')
          .update({ status: 'success', completed_at: new Date().toISOString() })
          .or(match)
          .eq('status', 'pending'), 'transfer.success withdrawals');
      }
    } else if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
      // transfer.failed always arrives while the row is still 'pending' (the transfer never
      // succeeded), but transfer.reversed can arrive AFTER transfer.success already flipped the
      // row to 'success' — the receiving bank accepted the transfer, then reversed it later. Both
      // are matched here so a reversal is never silently ignored: author_balance_kobo() only
      // counts a withdrawal that's still 'pending' or 'success' against the writer's balance, so
      // flipping a reversed transfer to 'failed' is what actually gives the writer their balance
      // back to withdraw again.
      const match = withdrawalMatch(event.data);
      if (match) {
        assertOk(await db.from('withdrawals')
          .update({ status: 'failed', failure_reason: event.data.reason || event.event })
          .or(match)
          .in('status', ['pending', 'success']), `${event.event} withdrawals`);
      }
    } else if (event.event === 'refund.processed' || event.event === 'charge.dispute.create') {
      // A buyer's bank dispute or a Paystack-processed refund on a charge that had already been
      // marked 'success' — see 50_migration_economy_security_audit.sql for why 'refunded' exists
      // and what excluding it from status = 'success' actually does downstream (author_balance_
      // kobo and settle_guild_event's pool sum both already only count 'success' rows). Paystack
      // nests the original charge reference differently across these two event types, so every
      // known location is tried; whichever of the three tables actually has a matching 'success'
      // row is the one this updates — the other two just match zero rows, same "safe to run all
      // three" reasoning charge.success above already relies on. Only a currently-'success' row
      // is ever touched — a still-'pending' or already-'failed' row is left alone, so this can
      // never manufacture a credit that charge.success itself never granted.
      const reference = event.data?.reference || event.data?.transaction?.reference || event.data?.transaction_reference;
      if (reference) {
        assertOk(await db.from('purchases')
          .update({ status: 'refunded' })
          .eq('paystack_reference', reference)
          .eq('status', 'success'), `${event.event} purchases`);
        assertOk(await db.from('guild_event_entries')
          .update({ status: 'refunded' })
          .eq('paystack_reference', reference)
          .eq('status', 'success'), `${event.event} guild_event_entries`);
        assertOk(await db.from('guild_event_hosting_fee_payments')
          .update({ status: 'refunded' })
          .eq('paystack_reference', reference)
          .eq('status', 'success'), `${event.event} guild_event_hosting_fee_payments`);
      }
    }
    // Any other event type: acknowledge and ignore, nothing here needs it.
    return new Response('ok', { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    // A legitimately-signed event we failed to process (database/server failure): 5xx so Paystack
    // retries it — acknowledging it with a 200 here would tell Paystack the money movement was
    // handled when it wasn't. Every update above is idempotent (status-guarded), so a retry is
    // safe. The detail goes to our own logs only; Paystack just gets a generic body.
    console.error('paystack-webhook error:', event?.event, e instanceof Error ? e.message : e);
    return new Response('Server error', { status: 500, headers: CORS_HEADERS });
  }
});
