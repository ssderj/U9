-- 167_migration_restore_activation_judging_gate.sql
--
-- The bug: migration 121 made activate_guild_event() refuse to open a host='guild' event unless a
-- judging configuration (guild_event_objective_config) is on file, lock that config, and assign
-- the judge panel when the config leaves weight on judging. Migration 131 then redefined
-- activate_guild_event() starting from the 108/109 body (financial agreement + escrow checks) and
-- silently dropped all of that. Since 131, an event can open for entries with no judging config
-- and no judges, and then can never be settled (settle_guild_event() requires a locked config,
-- see 121).
--
-- The fix: activate_guild_event() below is migration 131's body byte-for-byte, plus migration
-- 121's judging block restored (same wording, same position: after the escrow checks, before the
-- final update). Nothing else changes. Safe to run anytime; no data changes. Events already
-- active are untouched — the gate only applies to future activations.
--
-- Deliberately NOT done here: judge-free ("no metric, no judges") configs for Giveaway,
-- Reading & Trivia and Tournament. Until those ship, those event types still need a config via
-- propose_guild_event_objective_config() like any other event.

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_objective guild_event_objective_config%rowtype;
  v_contributed bigint;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can activate this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'published' then
    raise exception 'Publish this event before opening it for entries.';
  end if;

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
    if v_event.funding_mode = 'contributors' then
      select coalesce(sum(amount_kobo), 0) into v_contributed
      from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow_contribution' and status = 'success';
      if v_contributed <> v_event.guaranteed_prize_kobo then
        raise exception 'This event''s guaranteed prize is only ₦% of ₦% funded by contributors — it cannot open for entries until it''s fully funded.',
          v_contributed / 100.0, v_event.guaranteed_prize_kobo / 100.0;
      end if;
    else
      if not exists (
        select 1 from guild_treasury_transactions
        where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
      ) then
        raise exception 'Deposit the guaranteed prize into escrow before opening this event for entries.';
      end if;
    end if;
  end if;

  -- Restored from migration 121 (dropped by 131): placements are computed, never declared. Every
  -- host='guild' event must have a judging configuration on file before it can open, and gets its
  -- judge panel (if the config leaves any weight on judging) assigned right here, before a single
  -- entrant has paid.
  if v_event.host = 'guild' then
    select * into v_objective from guild_event_objective_config where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no judging configuration on file — it cannot open for entries.';
    end if;
    if not v_objective.locked then
      update guild_event_objective_config set locked = true, locked_at = now() where id = v_objective.id;
    end if;
    if v_objective.weight_bps < 10000 then
      perform assign_guild_event_judges(p_event_id);
    end if;
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function activate_guild_event(uuid, uuid) from public;
grant execute on function activate_guild_event(uuid, uuid) to authenticated;
