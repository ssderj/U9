-- 180_migration_judge_free_place_limits.sql
--
-- For now the judge-free guild events pay a limited number of places, and the server enforces it:
--   * giveaway                   -> 1 place only (one winner takes the whole prize)
--   * quiz (reading_challenge)   -> 1st-3rd only
--   * tournament                 -> 1st-3rd only (176 already refuses others, but only at activation)
--
-- Two places, so a host hears about it when saving, and a direct call can't get around it:
--   1. propose_guild_event_objective_config() (136's body + the place rule) refuses a split outside the
--      limit while the event is still a draft.
--   2. a trigger on opening (same shape as 174's quiz gate and 176's tournament gate) re-checks the saved
--      split for giveaway and quiz, covering any draft saved before this migration.
-- Safe to apply more than once (create or replace / drop-and-recreate trigger).

-- 1. Draft-time rule ---------------------------------------------------------------------------
create or replace function propose_guild_event_objective_config(
  p_guild_id uuid, p_event_id uuid, p_metric text, p_weight_bps integer, p_placement_split_bps jsonb
)
returns guild_event_objective_config
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_objective_config%rowtype;
  v_dup_place boolean;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can configure how this event is judged.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not use this configuration.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Judging can only be configured while the event is a draft.';
  end if;

  if p_metric not in ('none', 'word_count', 'on_time_completion') then
    raise exception 'Unknown objective metric.';
  end if;
  if p_metric = 'none' and coalesce(p_weight_bps, 0) <> 0 then
    raise exception 'An objective weight requires an objective metric.';
  end if;
  if p_weight_bps is null or p_weight_bps < 0 or p_weight_bps > 10000 then
    raise exception 'Objective weight must be between 0%% and 100%%.';
  end if;
  if guild_event_placement_split_sum(p_placement_split_bps) <> 10000 then
    raise exception 'Placement shares must add up to exactly 100%%.';
  end if;

  -- Migration 136: each place may only be declared once.
  select exists (
    select 1 from jsonb_array_elements(p_placement_split_bps) elem
    group by (elem->>'place')
    having count(*) > 1
  ) into v_dup_place;
  if v_dup_place then
    raise exception 'Each place (1st, 2nd, ...) can only be declared once in the placement split.';
  end if;

  -- Migration 180: how many places this kind of event pays for now.
  if v_event.event_type = 'giveaway' and exists (
    select 1 from jsonb_array_elements(p_placement_split_bps) e where (e->>'place')::integer <> 1
  ) then
    raise exception 'A giveaway has one winner — the whole prize goes to 1st place.';
  end if;
  if v_event.event_type in ('reading_challenge', 'tournament') and exists (
    select 1 from jsonb_array_elements(p_placement_split_bps) e where (e->>'place')::integer not between 1 and 3
  ) then
    raise exception 'This kind of event pays 1st, 2nd and 3rd place only — remove any other place from the prize split.';
  end if;

  insert into guild_event_objective_config
    (event_id, guild_id, metric, weight_bps, placement_split_bps, created_by)
  values (p_event_id, p_guild_id, p_metric, p_weight_bps, p_placement_split_bps, auth.uid())
  on conflict (event_id) do update set
    metric = excluded.metric, weight_bps = excluded.weight_bps,
    placement_split_bps = excluded.placement_split_bps, updated_at = now()
  returning * into v_row;
  if v_row.locked then
    raise exception 'This event''s judging configuration is already locked.';
  end if;
  return v_row;
end;
$$;
revoke all on function propose_guild_event_objective_config(uuid, uuid, text, integer, jsonb) from public;
grant execute on function propose_guild_event_objective_config(uuid, uuid, text, integer, jsonb) to authenticated;

-- 2. Opening gate for giveaway and quiz (tournament keeps its own gate from 176) ----------------------
create or replace function guild_place_limit_activation_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_split jsonb;
  v_max integer;
begin
  if new.host = 'guild' and new.event_type in ('giveaway', 'reading_challenge')
     and new.approval_status = 'active' and old.approval_status is distinct from 'active' then
    v_max := case when new.event_type = 'giveaway' then 1 else 3 end;
    select c.placement_split_bps into v_split from guild_event_objective_config c where c.event_id = new.id;
    if v_split is not null and exists (
      select 1 from jsonb_array_elements(v_split) e where (e->>'place')::integer not between 1 and v_max
    ) then
      if v_max = 1 then
        raise exception 'A giveaway has one winner — the whole prize goes to 1st place.';
      end if;
      raise exception 'This kind of event pays 1st, 2nd and 3rd place only — remove any other place from the prize split.';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function guild_place_limit_activation_gate() from public, anon, authenticated;

drop trigger if exists guild_place_limit_activation_gate on guild_events;
create trigger guild_place_limit_activation_gate
  before update of approval_status on guild_events
  for each row execute function guild_place_limit_activation_gate();
