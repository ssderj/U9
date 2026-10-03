-- Migration 189: an official quiz or tournament never ranks an entrant whose entry was refunded.
--
-- WHY: official_event_placements() (185) ranked quiz attempts and the tournament podium without looking at the entry
-- itself. Paystack's refund.processed webhook flips a refunded entry's status to 'refunded' (migration 50), and the
-- refunds-owed list (186) hands money back by hand, so a paid entrant who was refunded could still finish in the top
-- places and be paid a prize from the reserve on top of getting the fee back. Only entries with status = 'success'
-- (free official entries included) can now be placed.
--
-- EFFECT: the ranking is otherwise identical to 185. If every submitter was refunded the function raises its existing
-- 'Nobody has a placement yet' error; auto_settle_official_quizzes() (187) logs that as a warning and leaves the quiz
-- 'closed' for an admin to cancel. In a tournament a refunded champion, finalist or third place is skipped and the
-- declared split is scaled across the places actually awarded, exactly as when a third place did not play.
-- Nothing else changes. Not run against a live database from the session that wrote it.

create or replace function official_event_placements(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_cfg guild_event_objective_config%rowtype;
  v_tourn guild_event_tournaments%rowtype;
  v_placements jsonb;
begin
  select * into v_event from guild_events where id = p_event_id;
  select * into v_cfg from guild_event_objective_config where event_id = p_event_id;
  if not found then
    raise exception 'This event has no prize split on file.';
  end if;

  if v_event.event_type = 'tournament' then
    select * into v_tourn from guild_event_tournaments where event_id = p_event_id;
    if not found then
      raise exception 'This tournament has no settings on file.';
    end if;
    if v_tourn.status = 'no_contest' then
      raise exception 'This tournament ended without a winner, so there is nothing to pay out. Cancel it to release the prize back to the reserve.';
    end if;
    if v_tourn.status <> 'finished' then
      raise exception 'This tournament isn''t finished — placements can only be computed once its final has been decided.';
    end if;
    -- 1st champion, 2nd losing finalist, 3rd the better semifinal loser (only if they played). The declared
    -- split is scaled across the places actually awarded; the floor's remainder goes to the top place.
    with podium as (
      select 1 as place, v_tourn.champion_id as entrant_id
      union all select 2, v_tourn.runner_up_id
      union all select 3, v_tourn.third_id
    ),
    declared as (
      select p.place, p.entrant_id, (elem->>'share_bps')::integer as declared_bps
      from podium p
      join jsonb_array_elements(v_cfg.placement_split_bps) elem on (elem->>'place')::integer = p.place
      where p.entrant_id is not null
        -- Migration 189: a refunded entry can't win a prize; the remaining places are scaled up as before.
        and exists (select 1 from guild_event_entries en
                    where en.event_id = p_event_id and en.entrant_id = p.entrant_id and en.status = 'success')
    ),
    scaled as (
      select d.place, d.entrant_id,
        ((d.declared_bps::bigint * 10000) / nullif((select sum(declared_bps) from declared), 0))::integer as raw_bps
      from declared d
    ),
    final_shares as (
      select s.place, s.entrant_id,
        s.raw_bps + case when s.place = (select min(place) from scaled)
          then 10000 - (select coalesce(sum(raw_bps), 0) from scaled) else 0 end as share_bps
      from scaled s
    )
    select jsonb_agg(jsonb_build_object('contributor_id', entrant_id, 'place', place, 'share_bps', share_bps) order by place)
    into v_placements from final_shares where share_bps > 0;
  else
    -- Quiz: score (as a percentage) high to low, then the fastest server-measured time, then who finished first.
    with ranked as (
      select a.user_id as entrant_id,
        row_number() over (
          order by (case when a.total > 0 then round(100.0 * a.score / a.total, 2) else 0 end) desc,
                   a.elapsed_ms asc nulls last, a.submitted_at asc
        ) as place
      from guild_quiz_attempts a
      where a.event_id = p_event_id and a.submitted_at is not null
        -- Migration 189: only entrants whose entry still stands (a refunded entry can't win a prize).
        and exists (select 1 from guild_event_entries en
                    where en.event_id = p_event_id and en.entrant_id = a.user_id and en.status = 'success')
    ),
    awarded as (
      select r.place, r.entrant_id, ((elem->>'share_bps')::integer) as raw_share_bps
      from ranked r
      join jsonb_array_elements(v_cfg.placement_split_bps) elem on (elem->>'place')::integer = r.place
    ),
    final_shares as (
      select a.place, a.entrant_id,
        a.raw_share_bps + case when a.place = (select min(place) from awarded)
          then 10000 - (select coalesce(sum(raw_share_bps), 0) from awarded) else 0 end as share_bps
      from awarded a
    )
    select jsonb_agg(jsonb_build_object('contributor_id', entrant_id, 'place', place, 'share_bps', share_bps) order by place)
    into v_placements from final_shares where share_bps > 0;
  end if;

  if v_placements is null or jsonb_array_length(v_placements) = 0 then
    raise exception 'Nobody has a placement yet — nobody submitted an attempt.';
  end if;
  return v_placements;
end;
$$;
revoke all on function official_event_placements(uuid) from public, anon, authenticated;
