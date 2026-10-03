-- 182_migration_quiz_pool_15_to_40.sql
--
-- Quiz (Reading & Trivia) question pool, on the backend spec's section 2 / 3 decision:
--   * a quiz needs at least 15 approved questions in its pool to open   (was 5, migration 172)
--   * a quiz's pool holds at most 40 questions                          (was 30, migration 172)
--
-- Both numbers live in one function each and every check reads them (172, 174, 176, 179), so this
-- is the whole change. Nothing else is touched:
--   * Tournaments have their own limits (guild_tournament_min_pool() = 15, guild_tournament_question_cap()
--     = 50, migration 176) and are unaffected.
--   * Quizzes already open or finished are untouched - the minimum is only checked when a quiz opens.
--   * A DRAFT quiz with 5-14 approved questions can no longer be opened until the host adds more.
--   * A pool that already holds 31-40 questions can't exist (old cap was 30), so nothing is over the new cap.
-- Safe to apply more than once.

create or replace function guild_quiz_min_questions() returns integer as $$ select 15; $$ language sql immutable;
create or replace function guild_quiz_question_cap()  returns integer as $$ select 40; $$ language sql immutable;

revoke all on function guild_quiz_min_questions(), guild_quiz_question_cap() from public, anon, authenticated;
