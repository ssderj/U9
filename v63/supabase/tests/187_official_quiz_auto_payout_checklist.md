# Migration 187 — official quiz auto-payout: manual checks

Needs migrations through 187 applied (pg_cron enabled) and at least 15 approved official questions. Accounts: **Admin A**,
**Players P1, P2, P3**. To avoid waiting for the 15-minute job, run `select auto_settle_official_quizzes();` in the SQL editor
(it returns how many quizzes it paid). Use a short quiz time limit (the minimum) to keep waits short.

## 1. Basic auto-payout
1. As A, create a FREE official quiz (prize ₦1,000, 50/30/20). P1, P2, P3 enter and take it with different scores.
2. As A: "End quiz now". Then run `auto_settle_official_quizzes()`. Expect: returns 1; event is `settled`; payouts add up to
   exactly ₦1,000 (`select sum(amount_kobo) from guild_event_prize_payouts where event_id = '<id>'` = 100000); winners' withdrawable
   balances rose; the reserve shows the prize as settled; players see their result on the card.
3. `admin_audit_log` has an `auto_settle_official_quiz` row with a null actor and amount 100000 (manual pays log `settle_official_event`).
4. Run the job again → returns 0, nothing paid twice. Tapping "Work out winners & pay" on the settled quiz → refused ("already settled").

## 2. Nobody is cut off mid-quiz
5. P1 starts a quiz (does not submit yet). As A, "End quiz now". Run the job → returns 0 and the quiz stays `closed`.
   As A, tap "Work out winners & pay" → refused with "1 player(s) are still finishing this quiz".
6. P1 submits inside their time limit → accepted. Run the job → the quiz is now paid and P1 is ranked with everyone else.
7. Repeat 5 but let P1's time (limit + 5 s) run out without submitting → the job pays without them; P1's late submit is refused.

## 3. Things that must not be paid automatically
8. A quiz where nobody submitted → job skips it silently, no warning spam; A can cancel it and the prize returns to the reserve.
9. An official TOURNAMENT that finishes → NOT paid by the job; A still pays with the button.
10. A guild (non-official) quiz → untouched by the job.
11. A cancelled official quiz → untouched.

## 4. Failure isolation
12. Make one quiz fail (for example remove its prize-split row in a scratch copy) beside a healthy one. Job pays the healthy
    quiz, logs a warning for the broken one, which stays `closed` and payable by hand once fixed.

## 5. Unchanged
13. Manual payout after a quiz with no in-flight players behaves exactly as in `185_official_events_checklist.md` step 12.
14. Cron: `select jobname, schedule from cron.job where jobname = 'auto-settle-official-quizzes';` → `*/15 * * * *`.
