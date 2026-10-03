-- 193_migration_draw_giveaway_client_role_check.sql
--
-- NOT YET APPLIED TO LIVE. Review, then apply once (Supabase SQL editor or `apply_migration`).
--
-- Audit finding: draw_guild_giveaway() skipped its organizer/authority check whenever
-- auth.uid() was null. That is the same null-uid bypass pattern fixed in 156/157/158. Today it is
-- not reachable (anon has no EXECUTE), but one future grant would open it. The check is now
-- skipped only for trusted server-side callers (pg_cron / service role, which carry no client
-- JWT role); anon and authenticated are always checked. Function body is otherwise identical to
-- the live definition. CREATE OR REPLACE keeps the existing grants.

create or replace function draw_guild_giveaway(p_event_id uuid)
returns guild_event_results
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_results%rowtype;
  v_tie guild_event_giveaway_ties%rowtype;
  v_winner uuid;
  v_total bigint;
  v_top integer;
  v_tied integer;
  v_pick bigint;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.event_type <> 'giveaway' or v_event.host <> 'guild' then
    raise exception 'Giveaway not found.';
  end if;

  -- The permission check is skipped ONLY for a trusted server-side caller (pg_cron's
  -- resolve_giveaway_ties, service role), which has no client JWT role. Any client role
  -- (anon / authenticated) is always checked, even if auth.uid() is null.
  if (auth.uid() is not null or coalesce(auth.role(), '') in ('anon', 'authenticated')) and not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_event.guild_id)
    or is_inkroot_admin()
  ) then
    raise exception 'Only this giveaway''s organizer, a guild authority, or Inkroot can draw it.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id;

  if v_event.status = 'cancelled' then
    raise exception 'A cancelled giveaway can''t be drawn.';
  end if;
  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    return v_row;
  end if;
  if v_event.approval_status <> 'completed' then
    raise exception 'Complete the giveaway before drawing it.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This giveaway has already been settled.';
  end if;
  if v_event.draw_method is null then
    raise exception 'This giveaway has no draw method on file.';
  end if;
  if v_event.guaranteed_prize_kobo is null or v_event.guaranteed_prize_kobo <= 0 then
    raise exception 'This giveaway has no escrowed prize to pay.';
  end if;

  select coalesce(sum(e.tickets), 0) into v_total from guild_giveaway_eligible(p_event_id, v_event.guild_id) e;
  if v_total = 0 then
    raise exception 'Nobody eligible entered this giveaway, so there is no one to draw.';
  end if;

  if v_event.draw_method = 'highest_entries' then
    select max(t.tickets), count(*) into v_top, v_tied from guild_giveaway_tied(p_event_id, v_event.guild_id) t;
    select * into v_tie from guild_event_giveaway_ties where event_id = p_event_id;

    if v_tied = 1 then
      select t.user_id into v_winner from guild_giveaway_tied(p_event_id, v_event.guild_id) t;
      return guild_giveaway_finish(p_event_id, v_winner,
        case when v_tie.event_id is not null and v_tie.resolved_at is null then 'no_longer_tied' else null end);
    end if;

    if v_tie.event_id is null then
      insert into guild_event_giveaway_ties (event_id, decide_by)
      values (p_event_id, now() + guild_giveaway_tie_window())
      on conflict (event_id) do nothing;
      return null;
    end if;
    if v_tie.resolved_at is null and now() < v_tie.decide_by then
      return null;
    end if;

    v_pick := guild_giveaway_random_index(v_tied);
    select w.user_id into v_winner from (
      select t.user_id, row_number() over (order by t.user_id) - 1 as rn
      from guild_giveaway_tied(p_event_id, v_event.guild_id) t
    ) w where w.rn = v_pick;
    return guild_giveaway_finish(p_event_id, v_winner, 'random_fallback');
  end if;

  v_pick := guild_giveaway_random_index(v_total);
  select w.user_id into v_winner from (
    select gp.user_id, sum(gp.tickets) over (order by gp.user_id) as running
    from guild_giveaway_eligible(p_event_id, v_event.guild_id) gp
  ) w
  where w.running > v_pick
  order by w.running
  limit 1;
  return guild_giveaway_finish(p_event_id, v_winner);
end;
$$;
