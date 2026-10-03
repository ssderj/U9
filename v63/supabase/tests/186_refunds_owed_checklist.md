# Migration 186 — refunds owed on cancelled paid events: manual checks

Needs migrations through 186 applied. Accounts: **Admin A** (platform admin), **Player P1**, **Player P2**, **Player P3**.
The app only TRACKS refunds. Money is sent by hand from Paystack's dashboard. Use small real amounts (or Paystack test mode).

## 1. Setup
1. As A, create a PAID official quiz (entry ₦200). P1 and P2 pay through Paystack. P3 does not enter.
   Expect: both entries `success`. Refunds owed list (Admin screen, "Refunds owed") is empty.

## 2. Official event, admin cancel path
2. As A, cancel the quiz with a reason. Expect: it shows cancelled. "Refunds owed" now lists P1 and P2, each ₦200,
   with the event title, an "Official" tag, the Paystack reference and the cancel reason. Total ₦400.
3. In SQL: `select refund_owed_at, refunded_at from guild_event_entries where event_id = '<id>'` → owed set, refunded null.
   Cancelling again → refused ("already been cancelled"); owed dates unchanged.

## 3. Marking refunded
4. Send P1's refund on Paystack, then tap "I sent this refund" on P1's row with a note. Expect: P1 leaves the list, P2 stays owed.
5. Tap the same action again (e.g. from a stale screen) → no error, `refunded_at` unchanged. `admin_audit_log` has ONE
   `mark_event_entry_refunded` row with A as actor and ₦200 (20000 kobo).
6. As P1 (non-admin) call `admin_list_refunds_owed()` and `admin_mark_entry_refunded(<P2 entry>)` → both refused.
7. Send P2's refund from Paystack but do NOT tap the button. When Paystack's `refund.processed` webhook arrives the
   entry status becomes `refunded` and P2 drops off the list by itself. (If the webhook isn't configured, just mark it.)

## 4. Guild (non-official) paid event, dispute cancel path
8. In a player guild, run a paid event, let P1 and P2 pay, then cancel it as A through the dispute cancel.
   Expect: both appear in the list, with no "Official" tag.
9. Owner-cancel of a paid event that already has a paid entrant is still refused (unchanged behaviour). Owner-cancel of
   a paid event with NO entrants works and adds nothing to the list.

## 5. Things that must NOT be owed
10. A FREE official quiz with entrants (amount 0), cancelled → nothing added to the list.
11. A giveaway with tickets, cancelled by A → nothing added. A pending (unpaid) entry → nothing added.

## 6. Late payment after cancel
12. P3 opens checkout for a paid event and leaves the Paystack window open. A cancels the event. P3 then completes payment.
    When the webhook lands, P3's entry becomes `success` AND appears in the list as owed.

## 7. Backfill
13. If any paid event was cancelled before 186 was applied, its `success` entries appear in the list right after applying.
