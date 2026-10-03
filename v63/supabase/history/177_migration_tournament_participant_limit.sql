-- 177_migration_tournament_participant_limit.sql
--
-- Closes a gap left by 176 (implementation plan step 2, "participant-limit default 2^rounds, locked at
-- activation"). set_guild_tournament_settings() sets the limit, but create/update_guild_event_draft()
-- write participant_limit straight from the event form, so saving the form afterwards put back whatever
-- the field held (usually blank = unlimited). The opening gate would still refuse an unlimited or too-big
-- limit only at the last moment, with an error.
--
-- Now the limit is enforced where it is written, by a trigger on guild_events, so the draft RPCs stay
-- untouched:
--   * a tournament whose settings are saved gets participant_limit = 2^rounds when the form leaves it
--     blank, and it is capped at 2^rounds when the form asks for more (a bracket of N rounds holds at most
--     2^N players). A LOWER limit is kept - that is the one thing the host may change.
--   * it only acts while the event is a draft/rejected one, and once the event is open the limit can't be
--     touched through the draft RPCs anyway (they only work on drafts), so it is locked from activation on.
--   * a tournament with no settings saved yet is left alone; the opening gate from 176 (which fills a blank
--     limit and refuses an out-of-range one) is still the backstop.
-- set_guild_tournament_settings() is unchanged: it already re-caps the limit when the rounds change.
-- Not run against a live database. Safe to apply once; function is create-or-replace, trigger is re-created.

create or replace function guild_tournament_clamp_participant_limit()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_rounds integer;
  v_max integer;
begin
  if new.host = 'guild' and new.event_type = 'tournament' and new.approval_status in ('draft', 'rejected') then
    select t.rounds into v_rounds from guild_event_tournaments t where t.event_id = new.id;
    if found then
      v_max := power(2, v_rounds)::integer;
      new.participant_limit := least(coalesce(new.participant_limit, v_max), v_max);
      if new.participant_limit < 2 then
        new.participant_limit := 2;
      end if;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guild_tournament_clamp_participant_limit on guild_events;
create trigger guild_tournament_clamp_participant_limit
  before update of participant_limit, event_type on guild_events
  for each row execute function guild_tournament_clamp_participant_limit();
