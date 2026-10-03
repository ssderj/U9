# Migration 185 — official quizzes and tournaments: manual checks

Needs migrations through 185 applied, the `paystack-init-event-entry` function redeployed, and at least 15 approved
official questions (50 for a full tournament pool test). Accounts: **Admin A** (platform admin), **Player P1**, **Player P2**,
**Player P3**, **Player P4**. None of the players may be linked profiles.

## 1. Create
1. As A, top up the prize reserve, then create a FREE official quiz (prize ₦1,000, split 50/30/20, 15 questions, 10 min).
   Expect: event open, reserve drops by ₦1,000. Try 14 questions → refused. Try 41 → refused. Try a split of 90% → refused.
2. As A, create a PAID official quiz (entry ₦200). Expect: created; entry fee shown on the card.
3. As A, create a tournament (4 rounds, prize ₦2,000, split 50/30/20). Try a place 4 in the split → refused.
4. Try creating with a prize larger than the reserve → refused with the reserve message.

## 2. Enter
5. P1 taps enter on the free quiz → "You're in". Tap again → still fine, still one entry.
6. P2 pays for the paid quiz through Paystack → in. P1 entering the paid quiz without paying is impossible.
7. A (admin) opens the free quiz card → sees "Inkroot admins can't play official events". Calling
   `enter_official_event_free` as A directly → refused. Same for a paid entry as A → refused.
8. Set a player limit of 2 on a new free quiz; P1, P2 enter; P3 → "full".

## 3. Reward gates (free entry must not count as paid participation)
9. A brand-new player whose ONLY activity is a free official entry: the Inkroot Official badge must not show the
   "paid event" requirement as met, and the Naira welcome reward's event signal must not be met.

## 4. Play and pay (quiz)
10. P1, P2, P3 take the free quiz (different scores; P2 and P3 tied on score, P3 faster). Ranking: highest score,
    then fastest time. A cannot start an attempt.
11. As A: "End quiz now" (or wait for the end date + hourly sweep) → status closed/completed.
12. As A: "Work out winners & pay". Expect: payouts add up to exactly ₦1,000; winners' withdrawable balance rises;
    reserve shows the prize as settled; P1..P3 see their result on the card. Doing it twice → refused.

## 5. Tournament
13. P1..P4 enter (free). As A, "Close entries & start" → bracket built (2 rounds for 4 players). A cannot start a match.
14. Play it through (or let the round deadlines resolve). After the final: "Work out winners & pay" pays champion,
    losing finalist and (only if they played) the better semifinal loser; unawarded shares are re-scaled.
15. Tournament with 1 entrant → closes as no-contest; "Work out winners & pay" refuses; "Cancel event" releases the
    prize back to the reserve.

## 6. Old paths still guarded
16. `admin_settle_inkroot_event` on an official quiz/tournament → refused (points to the new function).
17. A guild-hosted quiz/tournament still behaves exactly as before (members of the hosting guild still can't enter).
