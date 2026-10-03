# Two-account test: migrations 166–177

Written without a database to run against — these are manual steps for a dev/staging project, not an
automated test. You need: **Host** (owner of a test guild), **Member** (joined to that guild),
**Player** (not in the guild), **Player2** (not in the guild), and **Admin** (`profiles.is_platform_admin = true`,
not in the guild). Give the test guild a funded treasury so the escrow deposit works.

Apply in order: 167 → 168 → 169 → 170 → 171 → 172 → 173 → 174 → 175 → 176 → 177 (166 is already live). 177 is a small trigger that keeps a tournament's player limit at or below 2^rounds (section 15, step 1). 176 adds the tournament (section 15) and supersedes 174's `guild_quiz_attach_to_pool()`, `host_add_guild_quiz_question()`, `suggest_guild_quiz_question()`, `guild_quiz_event_anthology()` and `list_public_guild_events()`, 175's `submit_guild_event_submission()`, 172's `compute_guild_event_placements()`, 171's `complete_guild_event()` and `close_ended_guild_events()`, 146's `apply_guild_event_entry_payment()` and 69's `close_guild_event()`. 175 supersedes 172's `submit_guild_event_submission()` (adds the writing-entry size limits, section 14). 174 moves quiz questions into a shared per-guild bank (section 12) and supersedes 172's quiz question/attempt functions and `list_public_guild_events()`; where section 8 below disagrees with section 12 (the 3-suggestion cap, pending suggestions being rejected at opening, questions belonging to one event), section 12 is right after 174. 173 supersedes 121's `approve_guild_event_results()` and 169's `settle_computed_guild_event()`. 172 supersedes 169's `compute_guild_event_placements()`, 170's `submit_guild_event_submission()` and 171's `list_public_guild_events()`. 170's `list_public_guild_events()` and
`get_my_guild_event_result()` are superseded by 171's versions, so after 171 those two return the giveaway
fields too — that is expected.

## 0. Confirm the migrations are applied
Run in the SQL editor; every row should come back `true`:

```sql
select 'min/max word count (166)' as what, exists (select 1 from information_schema.columns where table_name='guild_events' and column_name='max_word_count')
union all select 'judging gate in activate (167)', pg_get_functiondef('activate_guild_event(uuid,uuid)'::regprocedure) ilike '%no judging configuration%'
union all select 'prize payouts table (168)', to_regclass('guild_event_prize_payouts') is not null
union all select 'prize trigger (168)', exists (select 1 from pg_trigger where tgname='guild_events_prize_required')
union all select 'admin judges (169)', pg_get_functiondef('assign_guild_event_judges(uuid)'::regprocedure) ilike '%is_platform_admin%'
union all select 'min judges setting (169)', to_regclass('guild_event_judging_settings') is not null
union all select 'server word count (170)', to_regprocedure('guild_event_count_words(text)') is not null
union all select 'giveaway tickets table (171)', to_regclass('guild_event_tickets') is not null
union all select 'draw method column (171)', exists (select 1 from information_schema.columns where table_name='guild_events' and column_name='draw_method')
union all select 'giveaway type is ready (171)', guild_event_type_backend_ready('giveaway')
union all select 'quiz questions table (172)', to_regclass('guild_quiz_questions') is not null
union all select 'quiz type is ready (172)', guild_event_type_backend_ready('reading_challenge')
union all select 'quiz score ranking (172)', pg_get_functiondef('compute_guild_event_placements(uuid,uuid[])'::regprocedure) ilike '%quiz_score%'
union all select 'question pools table (174)', to_regclass('guild_event_quiz_pool') is not null
union all select 'questions belong to a guild (174)', exists (select 1 from information_schema.columns where table_name='guild_quiz_questions' and column_name='guild_id')
union all select 'attempt reads the pool (174)', pg_get_functiondef('start_guild_quiz_attempt(uuid)'::regprocedure) ilike '%guild_event_quiz_pool%'
union all select 'writing entry limits (175)', pg_get_functiondef('submit_guild_event_submission(uuid,text,integer,jsonb)'::regprocedure) ilike '%projectTitle%'
union all select 'tournament tables (176)', to_regclass('guild_event_tournament_matches') is not null and to_regclass('guild_event_tournament_match_questions') is not null
union all select 'tournament type is ready (176)', guild_event_type_backend_ready('tournament')
union all select 'tournament ranking (176)', pg_get_functiondef('compute_guild_event_placements(uuid,uuid[])'::regprocedure) ilike '%guild_event_tournaments%'
union all select 'round job scheduled (176)', exists (select 1 from cron.job where jobname = 'resolve-tournament-rounds');
```

## 1. Prize rule (168)
1. **Host** creates a writing contest draft with no guaranteed prize and submits for approval → refused ("must lock a prize in escrow").
2. Set a guaranteed prize, deposit it, submit → accepted.

## 2. Judged event: admin judges, admin-only compute, no auto-pay (167 + 169)
1. Make sure at least 3 admins are eligible (or run `select admin_set_guild_event_min_judges(2);` as Admin). Admins who belong to the host guild don't count.
2. **Host** proposes a judging config with weight < 100%, gets the event approved and published (Admin approves), then activates it → succeeds, and `select judge_id from guild_event_judges where event_id = '<id>'` lists only admins.
3. **Player** enters (pays) and submits a piece. **Member** tries to enter → refused ("Members of the hosting guild can't enter…").
4. Judges score. **Host** completes the event, then calls compute → refused ("computed by Inkroot").
5. **Admin** calls `compute_guild_event_placements` → result status `computed`, event **not** settled, no row in `guild_event_prize_payouts`.
6. **Admin** recomputes passing one judge id in `p_exclude_judge_ids` → still `computed`. Recompute once more passing `null` for `p_exclude_judge_ids` → same result as passing `'{}'` (a NULL must not drop every judge's scores).
7. **Admin** calls `settle_computed_guild_event('<id>')` → event `settled`, one row in `guild_event_prize_payouts` for Player, and Player's `author_balance_kobo` rose by the prize.
8. Calling `settle_computed_guild_event` again → refused ("already been settled").

## 3. Judge-free events open with a locked no-judge config (169; ready flags flipped by 171, 172, 176)
For each of **giveaway**, **quiz** and **tournament**: **Host** drafts the event through to `published` (a giveaway and quiz need a deposited prize; a tournament also needs its rounds and question pool), then activates → succeeds. Then, as postgres:
`select metric, weight_bps, locked from guild_event_objective_config where event_id = '<id>';` → `giveaway_draw` / `quiz_score` / `tournament_bracket`, `10000`, `true`.
`select count(*) from guild_event_judges where event_id = '<id>';` → `0`.
(Before 171 a giveaway was refused with "isn't available to open yet"; that no longer applies.)

## 3b. Place limits (180)
1. **Host** saves a quiz or tournament draft with a prize split that includes place 4 (through the app the form blocks it; to hit the server, call `propose_guild_event_objective_config` directly) → refused ("1st, 2nd and 3rd place only"). Places 1–3 are accepted.
2. A giveaway split with any place other than 1 → refused ("one winner").
3. The form shows the note "For now this kind of event pays 1st, 2nd and 3rd place only", hides "+ Add place" after 3 rows, and a giveaway shows the one-winner note.

## 4. Payout hygiene (168)
1. A pure-objective event (metric at 100%, no judges) computes and pays in one step; the host-guild members never appear in placements.
2. Player withdraws the prize without being in any guild → works.

## 5. Shared fixes (170)
1. **Own result.** After the event in section 2 is settled, **Player** calls `select * from get_my_guild_event_result('<id>')` → one row with `my_place = 1` and `my_amount_kobo` equal to the prize. A second entrant who paid but didn't place gets a row with null place/amount. **Member** (or anyone who never entered) gets no rows. Before settlement (status `computed`) nobody gets a row.
2. **Public listing.** As any signed-in user, `select rules, guaranteed_prize_kobo, min_word_count, max_word_count from list_public_guild_events()` returns real values for your test event.
3. **Server word count.** On a writing event with a range of, say, 50–100 words, call `submit_guild_event_submission` directly with `p_word_count => 75` but a `{"text": "<div>ten words here...</div>"}` that really has 10 → refused ("at least 50 words"). Send `{"text": "..."}` with 75 real words but `p_word_count => 1` → accepted, and the saved `word_count` is 75.
4. **Non-text content.** A world-building submission (`{"worldPiece": ...}`) on an event with **no** range still saves, and its saved `word_count` is **0** even if you send `p_word_count => 5000`; on a writing event **with** a range it is refused.
5. **Glued words.** `select guild_event_count_words('one' || chr(160) || 'two three')` → `3` (a no-break space separates words, same as the app's `wordCount()`); `select guild_event_count_words('<div>a</div><div>b</div>')` → `2`; `select guild_event_count_words('')` → `0`. (Run as the postgres/service role — the function is not callable by clients.)

## 6. Giveaway (171)
Use **Host**, **Member**, **Player**, **Player2**, **Admin**. Host creates a giveaway draft with `p_draw_method => 'highest_entries'`, a guaranteed prize, and an agreement with the prize pool at 100%; Admin approves; Host pays the hosting fee, publishes, deposits escrow and activates.
1. Creating a giveaway with no draw method, or a non-giveaway with one → refused. A giveaway saved with any entry fee ends up with fee 0.
2. **Player** calls `add_giveaway_ticket('<id>')` → returns 1, then 2, 3… **Member** → refused ("hosting guild"). The paid-entry function on a giveaway → refused.
3. **Speed limit:** call it 11 times inside one minute → the 11th is refused ("Too many requests"). Wait a minute and carry on.
4. **Cap:** run `update guild_event_tickets set ticket_count = 100 where user_id = '<Player>'` (SQL editor), then tap → refused ("100 ticket limit").
5. **Player2** taps once. Host completes the event → the draw runs by itself. `select * from guild_event_giveaway_draws` shows Player as winner (most tickets), the result is `approved`, `guild_event_prize_payouts` has one row for Player, and Player's withdrawable balance went up by the full prize. `get_my_guild_event_result` returns place 1 for Player and a null place for Player2.
6. **Tie (181):** repeat with `highest_entries` and two players on equal tickets, then complete the event → nobody is paid yet; `select * from guild_event_giveaway_ties` has one open row with `decide_by` 48 hours ahead. `get_giveaway_tie_status('<id>')` returns the deadline to anyone signed in, with `tie_can_decide` true only for Host. `get_giveaway_tie_candidates('<id>')` lists both players for Host and nothing for Player.
   - **Host picks:** Player tries `decide_giveaway_tie` → refused ("organizer or a guild authority"). Host picks someone not tied → refused ("Pick one of the people who are tied"). Host picks Player2 → paid at once, result `approved`, `guild_event_giveaway_draws.tie_resolution = 'host_choice'`, the tie row resolved. Calling it again → refused ("already has a winner").
   - **Fallback:** on a second tied giveaway run `update guild_event_giveaway_ties set decide_by = now() - interval '1 minute' where event_id = '<id>';` then `select resolve_giveaway_ties();` as postgres → one of the two tied players is paid, `tie_resolution = 'random_fallback'`. Host's `decide_giveaway_tie` now → refused ("48 hours ... have passed").
   - **Shrinking tie:** with two tied players and the tie open, make one join the host guild, then run `select draw_guild_giveaway('<id>');` as Host → the other is paid, `tie_resolution = 'no_longer_tied'`.
   - In the app: Host sees "It's a tie for the most entries" with one button per tied person and a confirm before paying; Player and Player2 see the same notice without buttons and never see "Draw pending…" while it is open.
7. **Weighted random:** repeat with `'weighted_random'` → some ticket holder wins; run 20 draws in a scratch database and the split roughly follows the ticket counts.
8. **Late joiner:** Player joins the host guild before the draw → skipped; if nobody else holds tickets, the draw refuses ("Nobody eligible") and the event stays `completed`.
9. `cancel_guild_event` on a giveaway that has tickets → refused.
10. Calling `draw_guild_giveaway` again after payout → returns the stored result, pays nothing twice.
11. **Who can retry a draw:** `draw_guild_giveaway('<id>')` works for Host (or Admin) and is refused for Player ("Only this giveaway's organizer, a guild authority, or Inkroot can draw it").
12. **Sweep:** let a second test giveaway pass its end date without pressing Complete, then run `select close_ended_guild_events();` as postgres → event is `completed` and already drawn/paid.

## 7. App screens (giveaway)
1. **Player** opens the giveaway card: the big counter shows the server's ticket count; tapping increases it only when the server accepts. On the 11th fast tap the red "Too many requests" message shows and the counter does not move.
2. **Member** of the host guild sees only "Members of the hosting guild can't enter…" — no tap button.
3. After the draw: the winner sees "You won!" with the prize amount; Player2 sees "The draw is done — not this time."; Host sees no result line but, if the draw failed, a "Run the draw" button.
4. Creating a giveaway in the form: the draw-method dropdown is enabled, picking one and saving works; changing the type to something else and saving does **not** send the draw method.

## 8. Quiz (172)
Same five accounts. Host creates a `reading_challenge` draft with a guaranteed prize and a 100% prize-pool agreement, then calls `set_guild_quiz_settings('<id>', 'none', null, 60)` (trivia, 60-second limit). Use a short limit while testing.
1. **Settings:** an unknown source, a time limit under 30s or over 7200s, or an anthology from another guild → refused. Calling it on a submitted (non-draft) event → refused.
2. **Host questions:** `host_add_guild_quiz_question` with 1 option, 7 options, duplicate option ids, or a correct id that isn't among the options → refused. Add 3 valid ones → they're `approved`.
3. **Suggestions:** **Member** calls `suggest_guild_quiz_question` → `pending`. A 4th active suggestion → refused ("at most 3"). **Player** (not in the guild) → refused. Once 30 non-rejected questions exist, anyone's next one → refused. Host rejects one of a member's → that slot frees up.
4. **Review:** Host `review_guild_quiz_question(id, true)` → approved; reviewing the same one again → refused; **Member** calling it → refused.
5. **Keys stay hidden:** as **Player** run `select * from guild_quiz_questions` → no rows/permission denied. `list_guild_quiz_questions_for_host` works for Host only.
6. **Opening gate:** with fewer than 5 approved questions, activate → refused ("at least 5 approved"). With 5+ and a suggestion still pending → activates, and the pending one is now `rejected`. After activation, adding/removing/reviewing a question → refused ("locked").
7. **Writer can't enter:** a question's author (Member) can't enter; if you make Player suggest through a temporary membership then leave the guild, Player's paid entry → refused ("you wrote a question").
8. **Attempt:** Player and Player2 enter (pay). **Player** calls `start_guild_quiz_attempt` → questions with `id, prompt, options` and **no** correct option anywhere in the JSON. Calling it again returns the same `started_at` (resume). **Member** or a non-entrant → refused.
9. **Grading:** Player submits answers `{questionId: optionId}` with 4 of 5 right → score 4, total 5, `elapsed_ms` from the server clock. Submitting again → refused. Player2 starts, waits past the limit + 5s, submits → refused ("Time's up"), no row in `guild_event_submissions`.
10. **Fake submission:** Player calls `submit_guild_event_submission` on the quiz → refused ("submitted through the quiz").
11. **Winners:** Host completes the event, then computes → Player placed 1st (Player2 unranked), paid at once through `guild_event_prize_payouts`. Repeat with equal scores → the faster `elapsed_ms` wins; equal time too → the earlier submission. `get_my_guild_event_result` shows Player's place; `list_public_guild_events()` returns `quiz_time_limit_seconds` and a question count, and no keys.
12. **Late finisher:** start an attempt, have Host complete the event, submit within the limit → accepted; after the result is computed, a still-unsubmitted attempt → refused ("closed").

## 9. App screens (quiz)
Not run in a browser — `node --check` only. Use the same accounts as section 8.
1. **Host** opens a new reading-challenge form → the quiz section says to save the draft first. After saving, reopening the draft shows source, time limit (minutes), the question list and an add-question form. Server errors (too few options, caps) show in red under the form.
2. **Member** opens the published quiz card → \"Suggest a question\" appears (not for Host, Player or non-members). The suggestion shows as \"Awaiting review\" with its key; Host sees it with Approve / Reject.
3. **Player** (entered) opens the active quiz → \"Start quiz\" states the time limit. Tapping it shows one question at a time with a `m:ss` countdown. Reload mid-quiz → the button says \"Resume quiz\" and the countdown continues from the server's remaining time. At 0:00 the answers given so far are submitted automatically.
4. After submitting: \"✓ Submitted — X of Y correct in N s\". Once the event is completed and computed: the winner sees \"You won #1 place — ₦… is in your balance\", others see \"The results are in — not this time.\"
5. **Host** (or the organizer / an admin) sees \"Work out the winners & pay them\" only on a completed, unsettled quiz. Pressing it pays at once; the old \"Submit results\" / \"Approve & pay winners\" controls do not appear on a quiz.
6. Open the browser dev tools network tab during step 3: no response from `start_guild_quiz_attempt` contains `correct_option_id`.

## 10. Computed-approval bypass closed + payout queue (173)
Use a judged event that **Admin** has computed (status `computed`, not yet settled), with **Host** as guild leader.
1. **Host** calls `approve_guild_event_results('<id>')` directly → refused ("paid by Inkroot"). The event stays unsettled and no row appears in `guild_event_prize_payouts`. (Before 173 this call succeeded and paid the prize.)
2. **Admin** runs `select * from admin_list_computed_guild_events();` → the event is listed with `placements` (place, share, winner name) and `judge_count`. **Host** and **Player** calling it → refused.
3. **Admin** calls `settle_computed_guild_event('<id>')` → settled, Player paid. The event disappears from the queue, and `select * from admin_audit_log where action = 'settle_computed_guild_event'` has one row whose `amount_kobo` equals the prize.
4. **Legacy path** (only on an event with no `guild_event_objective_config` row, i.e. created before 167): organizer submits results, a *different* guild authority approves → still works, and now writes an `approve_guild_event_results` audit row.
5. Judge-free events (giveaway, quiz) are unaffected: they still pay in the same call that computes or draws them, and never appear in the queue.

## 11. App screens: results flow cleanup (front-end for 173)
Not run in a browser — `node --check` only; a `vite build` hasn't been run either. Same accounts as above.
1. **Host** opens a new giveaway form → no judging box at all (just the draw-method fields). Reading & Trivia / Tournament forms show only "Prize split by place" plus a note that there are no judges. A writing contest or world-building form still shows the full judging box (metric, weight, split).
2. Save a giveaway, then a quiz, after first switching the type from a writing contest that had a non-default metric → the saved judging row is neutral (metric none, weight 0); activation then replaces it, as before.
3. On a **completed, unsettled** writing contest, **Host** sees "Inkroot's judges scored this event… nothing for the guild to submit or approve" and no Submit/Approve/Reject controls. On a completed **quiz** or an objective (metric 100%) event, Host/organizer sees "Work out the winners & pay them"; pressing it pays at once.
4. **Admin** on a completed judged event sees "Compute placements"; after it succeeds the same card offers "Recompute" and "Pay the winners". The admin screen's "Judged events awaiting payout" lists the same event with winners; "Pay the winners" there removes it from the list.
5. A completed **giveaway** shows no results controls on the card (its own panel handles the draw).
6. **Legacy check:** an event with no `guild_event_objective_config` row still shows "Submit results…" to its organizer and the approve/reject block to a different guild authority.
7. After settlement, **Player** (a writing-contest entrant who placed) sees "You won #1 place — ₦… is in your balance"; an entrant who didn't place sees "The results are in — not this time."; **Member** / a non-entrant sees nothing.

## 12. Shared question bank (174)
Same five accounts, plus a second anthology in the test guild if you have one. Host creates a `reading_challenge` draft (guaranteed prize, 100% prize-pool agreement) and calls `set_guild_quiz_settings('<id>', 'none', null, 60)`.
1. **Existing quizzes still score.** For any quiz that had questions before 174: `select count(*) from guild_event_quiz_pool where event_id = '<id>'` equals its number of approved questions, and a running attempt still grades with the same total. `select count(*) from guild_quiz_questions where guild_id is null` → 0.
2. **Bank, no event.** **Member** calls `suggest_guild_bank_question('<guild>', null, ...)` → `pending`, with `event_id` null. **Player** (not in the guild) → refused. An `anthology_id` from another guild → refused. An 11th waiting suggestion → refused (\"at most 10\"). Host rejects one → the slot frees up.
3. **Reuse.** **Host** approves Member's question with `review_guild_quiz_question` (event_id null, so nothing auto-adds), then `attach_guild_quiz_questions('<quiz>', array['<id>'])` → returns the new pool size. Create a second draft quiz on the same bank and attach the same question → works. Attaching it to a quiz on a *different* anthology, or an unapproved one → refused (\"different question bank\" / \"only approved\").
4. **Auto-add on approval.** **Member** calls the old `suggest_guild_quiz_question('<quiz>', ...)` while the quiz is a draft; Host approves it → it appears in `list_guild_quiz_questions_for_host` with `in_pool = true`. Do the same on a quiz whose pool is already at 30 → the approval succeeds but `in_pool = false`.
5. **Pool freezes on opening.** With fewer than 5 approved questions *in the pool* (even if the bank has more), activate → refused. With 5+ → activates, and a suggestion still `pending` is **left pending** (not rejected). Afterwards `attach_guild_quiz_questions`, `detach_guild_quiz_question` and `host_add_guild_quiz_question` on that quiz → refused (\"locked\").
6. **Changing the book empties the pool.** On a draft quiz with 3 questions in its pool, change the anthology with `set_guild_quiz_settings` → `guild_event_quiz_pool` has no rows for it; the questions still exist in the bank.
7. **The author ban.** The writer of a question in the pool (**Member**, or **Player** after a temporary membership) trying to enter → refused (\"you wrote a question\"). The same Member writes a *new* bank question that is **not** in the pool → does not change anything for that quiz. A host-guild member can't enter either way (169). An author who *has* somehow entered (insert an entry row as the service role) → `start_guild_quiz_attempt` refused, and attaching one of their questions → refused.
8. **Editing.** Writer edits their own approved question → status `pending`, removed from the pool of any draft quiz. Editing a question used by an **active or finished** quiz → refused (\"write a new one\"). **Player** editing someone else's → refused. `remove_guild_quiz_question` on a question used by an active quiz → refused; on an unused one → deleted.
9. **Keys stay hidden.** As **Player**: `select * from guild_quiz_questions` and `select * from guild_event_quiz_pool` → no rows/permission denied. `list_guild_bank_questions` works for Host only; `get_guild_bank_counts` works for any guild member and returns only two numbers; **Player** → refused.
10. **Grading from the pool.** Player and Player2 enter, start → the question JSON has only questions from the pool and **no** correct option. A question that is in the bank but not the pool never appears. Submit → score/total match the pool; `list_public_guild_events()` returns `quiz_question_count` equal to the pool size.
11. **Delete a draft event** → its questions are still in the bank (`event_id` null), and the pool rows are gone.

## 13. App wrappers (front-end for 174)
Wrappers only (`node --check`); there is no bank screen yet — the current quiz screens keep working unchanged. In the browser console: `fetchGuildBankCounts('<guild>')` as Member → `{ approved, pending }`; as Player → `null`. `suggestGuildBankQuestion(...)` throws the server's message on a cap or non-member.

## 14. Writing contest (166, 170, 175)
Use **Host**, **Player** and a writing-contest event with a word range of 50–100 that is active, with Player entered (paid). Nothing here needs new accounts.
1. **166 is applied.** Section 0's first row is `true`, and `select min_word_count, max_word_count from guild_events where id = '<id>'` shows 50 and 100.
2. **The server counts, not the client.** **Player** calls `submit_guild_event_submission('<id>', 'T', 75, '{"text":"<div>ten words here</div>"}')` with 10 real words → refused (\"at least 50 words\"). Then 75 real words with `p_word_count => 1` → accepted, and the saved `word_count` is 75. (This is section 5, step 3; repeat it here if you skipped it.)
3. **Linked project shape.** Send `{"text": "<75 words>", "projectId": "abc", "projectTitle": "My Novel"}` → accepted, and the row keeps the project id and title.
4. **Label limits (175).** The same call with a `projectTitle` of 201 characters → refused (\"too long\"); a `projectId` of 101 characters → refused; a `projectId` that is a number or `null` → refused. A 200-character title → accepted.
5. **Size limit (175).** A `{"text": "<75 words>", "padding": "<6MB of x>"}` → refused (\"too large\"). A world-building piece (`{"worldPiece": ...}`) of a few MB on an event with no range → still accepted, as before.
6. **Text size (170).** A `text` over 1,000,000 characters → refused (\"too long\").
7. **App: linked project.** **Player** links one of their own projects in the entry form, submits, then **a judge** (or Host, via the judge screen) opens the entry → the body reads as plain paragraphs, with no `<div>` or `</div>` text. The word count shown to Player before submitting matches the saved `word_count`.
8. **App: .txt only.** Choosing a `.pdf` or `.docx` in the upload box shows \"Only .txt files can be uploaded\".

## 15. Tournament (176)
Same five accounts, plus **Player3** and **Player4** (not in the guild) so a bracket has four players; a few more make the bye cases testable. Host creates a `tournament` draft (guaranteed prize deposited, 100% prize-pool agreement, judge-free split of 60/25/15 on places 1–3) and calls `set_guild_tournament_settings('<id>', 4, 'none', null)`. To make deadlines testable, move them in the SQL editor instead of waiting a day: `update guild_event_tournament_matches set deadline_at = now() - interval '1 minute' where event_id = '<id>' and round = 1;` and then `select resolve_tournament_rounds();` as postgres.
1. **Settings.** `set_guild_tournament_settings` with 3 or 7 rounds → refused; with another guild's anthology → refused; as **Player** → refused. Saving again after the event leaves draft → refused. `select participant_limit from guild_events where id = '<id>'` is 16. Then save the event form with the limit blank → still 16; with 100 → 16; with 8 → 8 (a lower limit is kept); with 1 → 2. Raise the rounds to 5 and the limit stays 8 (only the ceiling moves). A tournament draft with no settings saved keeps whatever the form sends. Changing the book empties the pool.
2. **Pool and opening.** Add 14 approved questions to the pool (host questions via `host_add_guild_quiz_question`, or member suggestions approved by Host) → activate is refused ("at least 15"). Add a 15th → activates. A split with a 4th place → refused at activation. After opening, attach/detach/add a question → refused ("locked"). A tournament pool accepts up to 50 questions (a quiz's stays at 30).
3. **Who can enter.** **Member** (in the host guild) → refused. The writer of a pool question → refused ("you wrote a question"). **Player**, **Player2**, **Player3**, **Player4** enter and pay.
4. **Closing below 2.** On a second tournament with only one paid entrant, Host presses close → refused ("needs at least 2 paid entrants"). With a fresh pending checkout (younger than 30 min) → refused ("still completing their payment"). The event stays open.
5. **Building the bracket.** Host closes entries on the four-player tournament → `guild_event_tournaments.status = 'running'`, `bracket_size = 4`, `bracket_rounds = 2`, `round_deadlines` holds two timestamps 24 h and 48 h after `entries_closed_at`. `select * from guild_event_tournament_matches where event_id = '<id>' order by round, slot` shows two open round-1 matches and one waiting final; each open match has 10 rows in `guild_event_tournament_match_questions`. Closing again → refused. A late `apply_guild_event_entry_payment(<reference of a new pending entry>)` → returns `over_limit` and the row becomes `failed`.
6. **Byes.** With 3 entrants (a separate event): size 4, one round-1 match is a bye (`is_bye`, `decided_by = 'bye'`, winner already set) and it is never the same as the other match. With 5–7 entrants: size 8 and byes never meet each other. With 2: one round, no semifinal.
7. **Playing.** As a player in a match: `get_my_tournament_state` returns `myMatch` with the opponent's name and no scores. `start_tournament_match` returns 10 questions with **no** correct option; the two opponents get the same question ids in the same order, but the option order differs per player and a second call gives the same order. **Player3** (in another match) calling it for this match → refused ("isn't your match"). Submitting before starting → refused. Submitting twice → refused. Submitting after `now() > started + 10 x 45 s + 5 s` → refused. `start_tournament_match` after the deadline → refused. The returned score/total match the answers.
8. **Hidden numbers.** While the match is open, `get_my_tournament_state` for either player never includes the opponent's score or any tab-switch count. `select * from guild_event_tournament_matches` as **Player** → no rows/permission denied; same for the tournaments and match-questions tables. `list_flagged_tournament_attempts` as **Player** → refused; as **Host** or **Admin** → lists attempts with tab switches at or above the minimum.
9. **Resolving round 1.** Both played → more correct wins (`decided_by = 'score'`); equal scores → the faster `elapsed_ms` wins (`'time'`); force an exact tie in the SQL editor (`update ... set a_score = 5, b_score = 5, a_elapsed_ms = 20000, b_elapsed_ms = 20000` before resolving) → a winner is picked and `decided_by = 'random'`. One played → that player wins (`'walkover'`). A player who started but never submitted counts as not having played. Neither played → both out (`'none'`). After `resolve_tournament_rounds()` the final has both winners and is open; the opponent's score is now visible in `myMatch` for the decided round-1 match, and only for a match where both submitted.
10. **Empty slots.** In an 8-player bracket, make neither player play one round-2 feeder pair: the other side's winner gets a bye in the final. Make both semifinals empty → the tournament ends `no_contest`, the event is `completed`, and `compute_guild_event_placements` refuses with the "nothing to pay out" message.
11. **Finishing and 3rd place.** Resolve the final: `guild_event_tournaments.status = 'finished'`, `champion_id`, `runner_up_id` (only if the loser actually played the final) and `third_id` set; the event is `completed` with status `closed`. `third_id` is the semifinal loser with more correct answers who actually played, else null. A 1-round (2-player) bracket has no `third_id`. **Host** calling `complete_guild_event` on a tournament → refused.
12. **Hourly sweep.** Set the tournament's `end_date` in the past while entries are still open and run `select close_ended_guild_events();` → entries close and the bracket is built (with under 2 paid entrants: `no_contest`, event `completed`). A running tournament (status `closed`, approval `active`) is never completed by the sweep, even long after its `end_date`.
13. **Placements and payout.** As **Host** (organizer/treasury authority) or **Admin**: `compute_guild_event_placements('<id>')` on the finished event → placements for places 1–3 pay the escrowed prize in full (shares re-scaled: with no 3rd, 60/25 becomes about 70.6/29.4, **not** all of the missing share on 1st) and `guild_event_prize_payouts` has one row per winner. Before the final is decided → refused ("isn't finished"). `get_my_guild_event_result` shows each winner their place. A tournament event has no rows in `guild_event_submissions`, and `submit_guild_event_submission` on it → refused.
14. **Cancelling.** A tournament with a paid entrant can't be cancelled by Host (as before). `admin_cancel_guild_event_dispute` by **Admin** works and releases the escrow.
15. **Public listing.** `list_public_guild_events()` returns `tournament_rounds` and `tournament_status` for the tournament, null for other events, and the participant count reflects paid entrants.
16. **App screens.** Host form (tournament type): save the draft, reopen it, choose rounds and the book, save the settings, build the pool (approve a member suggestion, add a question, add one from the bank, take one out), open the bracket designer preview. The entrant sees "Waiting for the bracket" before closing, then the opponent's name, a countdown and a Play button; a refresh mid-match resumes the same clock; tab away and back, submit, and the host's "Matches worth a look" lists it, worded as a signal and not as proof (roadmap 1.4). After the deadline the screen shows the result and the bracket; the podium shows when it finishes. The host sees "Close entries & start the bracket" and no "Mark completed", and "Work out the winners & pay them" once the tournament is done. A Member of the hosting guild can suggest questions but the card says they can't enter.

## 16. Quiz suggestion rate limit (178) and the official question bank (179)
Apply 178 then 179 (179 uses 178's `quiz_suggest` limit). Accounts: **Admin** and **Admin2** (both `profiles.is_platform_admin = true`), **Host**, **Member**, **Player**.
1. **Rate limit (178).** As **Member** of a guild, call `suggest_guild_bank_question` 20 times in an hour with valid questions (delete or reject them as you go so the 10-waiting cap doesn't stop you first) → the 21st raises "Too many requests". A call that fails validation (e.g. one option) does **not** use up a slot. `suggest_guild_quiz_question` shares the same counter. Host's `host_add_guild_bank_question` is not limited.
2. **Suggest.** As **Admin**: `suggest_inkroot_quiz_question('Who wrote X?', '[{"id":"a","text":"A"},{"id":"b","text":"B"}]', 'a')` → a uuid; the row has `scope = 'inkroot'`, `guild_id` and `anthology_id` null, `status = 'pending'`. As **Host**, **Member** or **Player** → refused ("Only an Inkroot admin"). The 11th waiting question from one admin → refused.
3. **Keys stay closed.** As **Player**: `select * from guild_quiz_questions` → no rows / permission denied. `list_inkroot_quiz_bank()` as **Host** or **Player** → refused. As **Admin** → the question with its key and `is_mine = true`; as **Admin2** → `is_mine = false`.
4. **Author can't approve.** **Admin** calls `review_inkroot_quiz_question(<id>, true)` → refused ("another admin has to review it"). **Admin2** → approved; `reviewed_by` is Admin2. Reviewing again → refused ("already reviewed"). A run from the SQL editor (no session) → refused by the admin gate.
5. **Edit and remove.** **Admin2** edits the approved question → back to `pending`, `reviewed_by` null. **Admin** still can't approve it if they wrote it; **Admin2** can. `remove_inkroot_quiz_question` deletes it. Removing or editing one that sits in an open or finished event's pool → refused (no official event uses the pool yet, so this can only be tested by inserting a pool row by hand).
6. **Guild functions ignore official questions.** As **Host** with a draft reading event: `attach_guild_quiz_questions('<event>', array['<official question id>'])` → refused ("different question bank"), never attached. `edit_guild_quiz_question('<official question id>', ...)` as **Admin** → "Question not found". `list_guild_bank_questions`, `get_guild_bank_counts` and `list_guild_quiz_questions_for_host` never show an official question.
7. **Existing guild quizzes unchanged.** A guild question still suggests, approves, attaches and grades as in section 12; `list_public_guild_events()` question counts are unchanged.

