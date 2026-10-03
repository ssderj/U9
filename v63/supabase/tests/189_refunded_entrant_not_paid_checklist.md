# Migration 189 - a refunded entrant is never ranked or paid: manual checks

Needs migrations through 189 applied. Accounts: **Admin A**, **Player P1**, **Player P2**, **Player P3**.
Use a PAID official quiz (entry N200) with a small prize. Money moves only by hand on Paystack.

1. As A, create a paid official quiz with a 3-place split. P1, P2 and P3 pay and each submit an attempt; P1 scores best.
2. Before the quiz ends, refund P1's payment in Paystack (or, in a scratch database, set P1's entry status to 'refunded').
   Expect: P1's entry shows refunded.
3. Let the quiz end and the 15-minute payout run (or press "Work out winners & pay" as A).
   Expect: P1 gets NO prize. P2 and P3 are paid; the split is the declared one scaled over the places awarded and the
   payouts add up to the prize exactly.
4. Repeat with every submitter refunded. Expect: nothing is paid, the quiz stays 'closed', the admin sees the error
   "Nobody has a placement yet", and cancelling it returns the prize to the reserve.
5. Tournament: refund the champion's entry after the final, then settle. Expect: the champion is skipped and the
   remaining places share the prize.

## Cancelled event page (front end)
6. Cancel a paid event that P2 entered. As P2, open the event from a link or notification.
   Expect: a "Cancelled" notice with the title and reason, not "This event couldn't be found."
7. Cancel a draft that never went public. Expect: opening it still says it couldn't be found.

## Official label (front end)
8. Open an official event as a player. Expect: ribbon "Official Inkroot Event", header "Inkroot - official event",
   and tapping the header does not open a guild. A guild event still shows its guild and "host guild".
