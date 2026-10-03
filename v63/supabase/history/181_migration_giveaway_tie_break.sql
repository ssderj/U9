-- 181_migration_giveaway_tie_break.sql
--
-- Highest-entries giveaway tie-break, on the rules the app owner confirmed:
--   * If two or more eligible entrants tie for the most tickets, the HOST GUILD picks the winner from
--     the tied people. The giveaway's organizer or a guild authority can do it (same people who can
--     retry a draw, minus Inkroot admins).
--   * The host has 48 hours from the moment the tie is found. After that a winner is picked at random
--     from the tied people, by the server's own random source.
--   * Replaces 171's "whoever reached the count first wins". weighted_random draws are unchanged.
--
-- How it works:
--   draw_guild_giveaway() (171's body + this rule) still runs when the event completes. With a single
--   top holder it pays as before. With a tie it opens a row in guild_event_giveaway_ties (deadline =
--   now + 48h), pays nobody and returns null — the callers (complete_guild_event, the hourly sweep)
--   only PERFORM it, so they are unaffected.
--   decide_giveaway_tie() lets the host pick one of the people who are tied right now.
--   resolve_giveaway_ties() runs every 15 minutes (pg_cron) and calls the draw again for every tie whose
--   48 hours are up, which takes the random fallback.
--   The tied set is always recomputed from the CURRENT eligible entrants (host-guild members who
--   joined after tapping, banned and linked profiles are dropped), so a stale list can't be paid.
--
-- Also: guild_event_giveaway_draws gets tie_resolution ('host_choice' | 'random_fallback' |
-- 'no_longer_tied') for the audit trail. Safe to apply more than once.

-- 1. Schema ---------------------------------------------------------------------------------------
alter table guild_event_giveaway_draws add column if not exists tie_resolution text;
alter table guild_event_giveaway_draws drop constraint if exists guild_event_giveaway_draws_tie_resolution_check;
alter table guild_event_giveaway_draws add constraint guild_event_giveaway_draws_tie_resolution_check
  check (tie_resolution is null or tie_resolution in ('host_choice', 'random_fallback', 'no_longer_tied'));

create table if not exists guild_event_giveaway_ties (
  event_id uuid primary key references guild_events(id) on delete cascade,
  opened_at timestamptz not null default now(),
  decide_by timestamptz not null,
  resolved_at timestamptz,
  resolution text check (resolution is null or resolution in ('host_choice', 'random_fallback', 'no_longer_tied')),
  chosen_by uuid references auth.users(id) on delete set null
);
alter table guild_event_giveaway_ties enable row level security;
-- No policies: read through get_giveaway_tie_status() / get_giveaway_tie_candidates() below.

create or replace function guild_giveaway_tie_window()
returns interval as $$ select interval '48 hours'; $$ language sql immutable;
revoke all on function guild_giveaway_tie_window() from public, anon, authenticated;

-- 2. Helpers --------------------------------------------------------------------------------------
-- Everyone currently eligible who holds the top ticket count.
create or replace function guild_giveaway_tied(p_event_id uuid, p_guild_id uuid)
returns table (user_id uuid, tickets integer)
language sql stable security definer set search_path = public as $$
  select e.user_id, e.tickets
  from guild_giveaway_eligible(p_event_id, p_guild_id) e
  where e.tickets = (select max(x.tickets) from guild_giveaway_eligible(p_event_id, p_guild_id) x);
$$;
revoke all on function guild_giveaway_tied(uuid, uuid) from public, anon, authenticated;

-- A random whole number 0 .. p_n-1 from the database's secure random source (the bytes of a freshly
-- generated random UUID), never from the client. Same construction 171 used inline.
create or replace function guild_giveaway_random_index(p_n bigint)
returns bigint
language plpgsql volatile as $$
declare
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_rand bigint;
begin
  v_rand := (get_byte(v_bytes, 0)::bigint << 40) | (get_byte(v_bytes, 1)::bigint << 32)
          | (get_byte(v_bytes, 2)::bigint << 24) | (get_byte(v_bytes, 3)::bigint << 16)
          | (get_byte(v_bytes, 4)::bigint << 8)  |  get_byte(v_bytes, 5)::bigint;
  return floor(p_n * (v_rand::numeric / 281474976710656))::bigint;
end;
$$;
revoke all on function guild_giveaway_random_index(bigint) from public, anon, authenticated;

-- Pays the winner: 171's result / settlement / audit steps, now shared by the draw, the host's tie
-- decision and the fallback. Callers already hold the entry and settlement advisory locks.
create or replace function guild_giveaway_finish(
  p_event_id uuid, p_winner uuid, p_tie_resolution text default null, p_chosen_by uuid default null
)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_results%rowtype;
  v_total bigint;
  v_entrants integer;
  v_winner_tickets integer;
begin
  select * into v_event from guild_events where id = p_event_id;
  select coalesce(sum(e.tickets), 0), count(*) into v_total, v_entrants
  from guild_giveaway_eligible(p_event_id, v_event.guild_id) e;
  select e.tickets into v_winner_tickets
  from guild_giveaway_eligible(p_event_id, v_event.guild_id) e where e.user_id = p_winner;
  if v_winner_tickets is null then
    raise exception 'That person is not an eligible entrant of this giveaway.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (
    v_event.guild_id, p_event_id,
    jsonb_build_array(jsonb_build_object('contributor_id', p_winner, 'place', 1, 'share_bps', 10000)),
    'computed', null, now()
  )
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'computed', submitted_by = null, submitted_at = now(),
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;

  perform set_config('inkroot.auto_settle_event', p_event_id::text, true);
  perform settle_guild_event(
    v_event.guild_id, p_event_id,
    jsonb_build_array(jsonb_build_object('contributor_id', p_winner, 'share_bps', 10000))
  );
  perform set_config('inkroot.auto_settle_event', '', true);
  update guild_event_results
    set status = 'approved', reviewed_by = null, reviewed_at = now(), settled_at = now()
    where event_id = p_event_id
    returning * into v_row;

  insert into guild_event_giveaway_draws
    (event_id, winner_id, method, eligible_entrants, eligible_tickets, winner_tickets, tie_resolution)
  values (p_event_id, p_winner, v_event.draw_method, v_entrants, v_total::integer, v_winner_tickets, p_tie_resolution)
  on conflict (event_id) do nothing;

  if p_tie_resolution is not null then
    update guild_event_giveaway_ties
      set resolved_at = now(), resolution = p_tie_resolution, chosen_by = p_chosen_by
      where event_id = p_event_id and resolved_at is null;
  end if;
  return v_row;
end;
$$;
revoke all on function guild_giveaway_finish(uuid, uuid, text, uuid) from public, anon, authenticated;

-- 3. The draw (171's checks, plus the tie rule) -----------------------------------------------------
create or replace function draw_guild_giveaway(p_event_id uuid)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
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

  if auth.uid() is not null and not (
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
    return v_row; -- already drawn and paid
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
      -- One clear top holder (possibly because a tied entrant has since become ineligible).
      select t.user_id into v_winner from guild_giveaway_tied(p_event_id, v_event.guild_id) t;
      return guild_giveaway_finish(p_event_id, v_winner,
        case when v_tie.event_id is not null and v_tie.resolved_at is null then 'no_longer_tied' else null end);
    end if;

    -- A tie. The host guild has 48 hours from when the tie is first found.
    if v_tie.event_id is null then
      insert into guild_event_giveaway_ties (event_id, decide_by)
      values (p_event_id, now() + guild_giveaway_tie_window())
      on conflict (event_id) do nothing;
      return null; -- waiting for the host's pick
    end if;
    if v_tie.resolved_at is null and now() < v_tie.decide_by then
      return null; -- still inside the host's 48 hours
    end if;

    -- The 48 hours are up: pick at random from the people tied right now. The index is drawn once,
    -- not per row.
    v_pick := guild_giveaway_random_index(v_tied);
    select w.user_id into v_winner from (
      select t.user_id, row_number() over (order by t.user_id) - 1 as rn
      from guild_giveaway_tied(p_event_id, v_event.guild_id) t
    ) w where w.rn = v_pick;
    return guild_giveaway_finish(p_event_id, v_winner, 'random_fallback');
  end if;

  -- Weighted random: every ticket is one chance.
  v_pick := guild_giveaway_random_index(v_total); -- 0 .. v_total-1
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
revoke all on function draw_guild_giveaway(uuid) from public, anon;
grant execute on function draw_guild_giveaway(uuid) to authenticated;

-- 4. The host's pick ----------------------------------------------------------------------------------
create or replace function decide_giveaway_tie(p_event_id uuid, p_winner_id uuid)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_tie guild_event_giveaway_ties%rowtype;
  v_row guild_event_results%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in first.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.event_type <> 'giveaway' or v_event.host <> 'guild' then
    raise exception 'Giveaway not found.';
  end if;
  if not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_event.guild_id)
  ) then
    raise exception 'Only this giveaway''s organizer or a guild authority can break the tie.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id;

  if v_event.status in ('cancelled', 'settled') then
    raise exception 'This giveaway is already finished.';
  end if;
  select * into v_row from guild_event_results where event_id = p_event_id;
  if found and v_row.status = 'approved' then
    raise exception 'This giveaway already has a winner.';
  end if;
  select * into v_tie from guild_event_giveaway_ties where event_id = p_event_id for update;
  if not found or v_tie.resolved_at is not null then
    raise exception 'There is no tie waiting for a decision.';
  end if;
  if now() >= v_tie.decide_by then
    raise exception 'The 48 hours to break this tie have passed — a winner is being picked at random.';
  end if;
  if not exists (select 1 from guild_giveaway_tied(p_event_id, v_event.guild_id) t where t.user_id = p_winner_id) then
    raise exception 'Pick one of the people who are tied for the most entries.';
  end if;

  return guild_giveaway_finish(p_event_id, p_winner_id, 'host_choice', auth.uid());
end;
$$;
revoke all on function decide_giveaway_tie(uuid, uuid) from public, anon;
grant execute on function decide_giveaway_tie(uuid, uuid) to authenticated;

-- 5. What the app reads ----------------------------------------------------------------------------------
-- Anyone signed in: is a tie waiting, and until when. can_decide is true only for the host side.
create or replace function get_giveaway_tie_status(p_event_id uuid)
returns table (tie_decide_by timestamptz, tie_can_decide boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_tie guild_event_giveaway_ties%rowtype;
begin
  if auth.uid() is null then
    return;
  end if;
  select * into v_event from guild_events where id = p_event_id and event_type = 'giveaway' and host = 'guild';
  if not found then
    return;
  end if;
  select * into v_tie from guild_event_giveaway_ties where event_id = p_event_id and resolved_at is null;
  if not found then
    return;
  end if;
  return query select v_tie.decide_by,
    ((v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
      or is_guild_treasury_authorized(v_event.guild_id));
end;
$$;
revoke all on function get_giveaway_tie_status(uuid) from public, anon;
grant execute on function get_giveaway_tie_status(uuid) to authenticated;

-- Host side only, and only while a tie is open: who is tied right now.
create or replace function get_giveaway_tie_candidates(p_event_id uuid)
returns table (candidate_id uuid, candidate_name text, candidate_tickets integer)
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if auth.uid() is null then
    return;
  end if;
  select * into v_event from guild_events where id = p_event_id and event_type = 'giveaway' and host = 'guild';
  if not found then
    return;
  end if;
  if not ((v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
          or is_guild_treasury_authorized(v_event.guild_id)) then
    return;
  end if;
  if not exists (select 1 from guild_event_giveaway_ties where event_id = p_event_id and resolved_at is null) then
    return;
  end if;
  return query
    select t.user_id,
           coalesce(nullif(p.display_name, ''), nullif(p.pen_name, ''), 'Entrant'),
           t.tickets
    from guild_giveaway_tied(p_event_id, v_event.guild_id) t
    left join profiles p on p.id = t.user_id
    order by 2, 1;
end;
$$;
revoke all on function get_giveaway_tie_candidates(uuid) from public, anon;
grant execute on function get_giveaway_tie_candidates(uuid) to authenticated;

-- 6. The 48-hour fallback --------------------------------------------------------------------------------
-- Cron-only (a pg_cron job has no JWT). Re-runs the draw for every tie whose 48 hours are up; the draw
-- itself takes the random fallback. A failed one is logged and retried on the next run.
create or replace function resolve_giveaway_ties()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_count integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'Not authorized.';
  end if;
  for v_id in
    select event_id from guild_event_giveaway_ties where resolved_at is null and decide_by <= now()
  loop
    begin
      perform draw_guild_giveaway(v_id);
      v_count := v_count + 1;
    exception when others then
      raise warning 'Giveaway tie fallback for event % failed: %', v_id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function resolve_giveaway_ties() from public, anon, authenticated;

select cron.schedule('resolve-giveaway-ties', '*/15 * * * *', $$select resolve_giveaway_ties();$$);
