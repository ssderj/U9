-- Migration 188: pause giveaway, quiz and tournament guild events until the two-account checks pass.
--
-- WHY: migrations 171, 172 and 176 switched these three types on in guild_event_type_backend_ready(), and they were
-- applied to the live database before the checks in supabase/tests (167-171 two-account checklist, 185, 186, 187)
-- were run. This turns them back off so no guild can open a NEW real-money event of these types until you have
-- tested. Run it, test, then run the RESUME statement at the bottom of this file as a new migration.
--
-- WHAT IT DOES NOT TOUCH:
--   * Events already open keep running: the function is only read when a guild event is ACTIVATED
--     (activate_guild_event(), migration 169, host = 'guild' only).
--   * Official Inkroot quizzes and tournaments (migration 185): admin-created, never gated by this function.
--   * Writing, world-building and every other event type ('else true').
--   * The JS constants GIVEAWAY_/QUIZ_/TOURNAMENT_BACKEND_READY: nothing in src/ reads them; this SQL function
--     is the real switch.
--
-- TO TEST GUILD EVENTS you must first switch the type back on (RESUME below), ideally with a test guild, because a
-- guild event cannot open while its type is paused.
--
-- Not run against the live database from the session that wrote it.

create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then false
    when 'reading_challenge' then false
    when 'tournament' then false
    else true
  end;
$$ language sql immutable;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;

-- RESUME (run this as its own new migration, e.g. 190_migration_resume_judge_free_event_types.sql, after the checks pass):
--
-- create or replace function guild_event_type_backend_ready(p_event_type text)
-- returns boolean as $$
--   select case p_event_type
--     when 'giveaway' then true
--     when 'reading_challenge' then true
--     when 'tournament' then true
--     else true
--   end;
-- $$ language sql immutable;
-- revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;
