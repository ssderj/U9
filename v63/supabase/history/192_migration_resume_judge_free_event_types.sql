-- Migration 192: turn giveaway, quiz and tournament guild events back ON.
--
-- WHY: migration 188 paused these three types (guild_event_type_backend_ready() returned false for them) so no
-- guild could open a NEW real-money event of that type before the two-account checks were run. They are being
-- switched on now, so this is the RESUME statement that file ended with.
--
-- WHAT IT CHANGES: only guild_event_type_backend_ready(). activate_guild_event() (migration 169, host = 'guild'
-- only) reads it when a guild event is activated, so guild giveaways, quizzes (reading_challenge) and
-- tournaments can open for entries again. Writing contests, world-building (workshop) and 'other' were never
-- paused.
--
-- OFFICIAL INKROOT EVENTS: nothing to switch. Official quizzes and tournaments (migration 185) never read this
-- function, so they were not paused by 188 and need no change here.
--
-- Events already open are unaffected. Events sitting in 'published' that could not be activated while paused can
-- now be activated by their host.
--
-- Safe to run more than once (create or replace). Not run against the live database from the session that wrote it.

create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then true
    when 'reading_challenge' then true
    when 'tournament' then true
    else true
  end;
$$ language sql immutable;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;
