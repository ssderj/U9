-- Migration 187: an official quiz pays its winners by itself once it is over.
--
-- WHY: migration 185 made an admin press "Work out winners & pay" after every official quiz. A quiz has no
-- flagged attempts to review (the answers are graded by the server), so waiting for a person adds delay and
-- a chance to forget. TOURNAMENTS STAY MANUAL on purpose: an admin should look at flagged attempts before
-- money moves. This migration changes nothing for tournaments.
--
-- WHAT IT DOES:
--   1. The payout body of admin_settle_official_event() moves into one internal function,
--      official_event_settle_locked(), so the admin button and the automatic job run EXACTLY the same code
--      (same ranking, same largest-remainder rounding, same reserve settlement, same results row).
--   2. A job runs every 15 minutes and settles each official quiz that has ended and is ready.
--   3. "Ready" means nobody is still finishing. submit_guild_quiz_attempt() lets a player who STARTED before
--      the quiz closed finish within (time limit + grace seconds), but refuses once a results row exists.
--      Paying the instant a quiz closes would therefore cut off players mid-quiz. Both the job and the admin
--      button now wait until every started attempt has either been submitted or run out of time.
--
-- WHAT IT DELIBERATELY DOES NOT DO:
--   * Quizzes nobody submitted are skipped silently (nothing to pay). An admin cancels them to return the
--     prize to the reserve; the job never cancels anything.
--   * A failure on one quiz is logged as a warning and never stops the others; that quiz stays 'closed'
--     and can still be paid with the admin button. The job is safe to re-run: an already settled or paid
--     quiz is never touched twice (status check + guild_event_prize_payouts check + row lock).
--   * No change to cancel: an admin can still cancel an ended, unpaid quiz until the job pays it. Because
--     the job waits for in-flight attempts and runs every 15 minutes, that window is short but real.
--   * Not run against a live database from this session.

-- 1. How many players are still inside their answer window -----------------------------------------------
create or replace function official_quiz_attempts_in_flight(p_event_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer
  from guild_quiz_attempts a
  join guild_events e on e.id = a.event_id
  where a.event_id = p_event_id
    and a.submitted_at is null
    and e.quiz_time_limit_seconds is not null
    and now() <= a.started_at + make_interval(secs => e.quiz_time_limit_seconds + guild_quiz_grace_seconds());
$$;
revoke all on function official_quiz_attempts_in_flight(uuid) from public, anon, authenticated;

-- 2. The shared payout body -------------------------------------------------------------------------------
-- Internal: callers must already have checked who is allowed to call it. p_audit_action tells the audit log
-- whether a person or the automatic job paid. Returns the settled event.
create or replace function official_event_settle_locked(p_event_id uuid, p_audit_action text)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_placements jsonb;
  v_row guild_events;
  v_in_flight integer;
begin
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id for update;
  if not found or v_event.host <> 'inkroot' or v_event.event_type not in ('reading_challenge', 'tournament') then
    raise exception 'Official event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' or v_event.approval_status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
  end if;
  if v_event.status <> 'closed' or v_event.approval_status <> 'completed' then
    raise exception 'This event isn''t over yet — it can be settled once it has ended.';
  end if;
  if exists (select 1 from guild_event_prize_payouts where event_id = p_event_id) then
    raise exception 'This event has already been paid out.';
  end if;

  -- Migration 187: a quiz can't be paid while a player who started in time is still answering.
  if v_event.event_type = 'reading_challenge' then
    v_in_flight := official_quiz_attempts_in_flight(p_event_id);
    if v_in_flight > 0 then
      raise exception '% player(s) are still finishing this quiz — try again in a few minutes.', v_in_flight;
    end if;
  end if;

  v_placements := official_event_placements(p_event_id);

  -- Largest-remainder rounding, the same method settle_guild_event() uses: the payouts add to the prize exactly.
  with shares as (
    select (s->>'contributor_id')::uuid as winner_id, (s->>'share_bps')::integer as share_bps
    from jsonb_array_elements(v_placements) s
    where (s->>'share_bps')::integer > 0
  ),
  amounts as (
    select winner_id,
      floor(v_event.cash_prize_kobo * share_bps::numeric / 10000)::bigint as base,
      (v_event.cash_prize_kobo * share_bps::numeric / 10000) - floor(v_event.cash_prize_kobo * share_bps::numeric / 10000) as frac
    from shares
  ),
  ranked as (
    select winner_id, base,
      row_number() over (order by frac desc, winner_id) as rn,
      (v_event.cash_prize_kobo - sum(base) over ())::bigint as leftover
    from amounts
  )
  insert into guild_event_prize_payouts (event_id, guild_id, winner_id, amount_kobo)
  select p_event_id, v_event.guild_id, winner_id, base + case when rn <= leftover then 1 else 0 end
  from ranked
  where base + case when rn <= leftover then 1 else 0 end > 0;

  perform platform_reserve_record_settlement(p_event_id);

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by)
  values (v_event.guild_id, p_event_id, v_placements, 'pending_approval', auth.uid())
  on conflict (event_id) do update set placements = excluded.placements, status = 'pending_approval';
  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_row from guild_events where id = p_event_id;

  -- actor_id is stamped from auth.uid(): the admin for a manual payout, null for the automatic job.
  perform record_admin_action(p_audit_action, 'guild_events', p_event_id,
    to_jsonb(v_event), to_jsonb(v_row), v_event.cash_prize_kobo, null);
  return v_row;
end;
$$;
revoke all on function official_event_settle_locked(uuid, text) from public, anon, authenticated;

-- 3. The admin button: same checks as before, now a thin wrapper --------------------------------------------
create or replace function admin_settle_official_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
begin
  if not is_inkroot_admin() or auth.uid() is null then
    raise exception 'Only an Inkroot admin can settle an official event.';
  end if;
  return official_event_settle_locked(p_event_id, 'settle_official_event');
end;
$$;
revoke all on function admin_settle_official_event(uuid) from public, anon;
grant execute on function admin_settle_official_event(uuid) to authenticated;

-- 4. The automatic job (official QUIZZES only) ------------------------------------------------------------
create or replace function auto_settle_official_quizzes()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_count integer := 0;
begin
  -- Same cron-only guard close_ended_guild_events() uses.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  for v_event_id in
    select e.id from guild_events e
    where e.host = 'inkroot'
      and e.event_type = 'reading_challenge'      -- tournaments stay manual
      and e.status = 'closed'
      and e.approval_status = 'completed'
      and not exists (select 1 from guild_event_prize_payouts p where p.event_id = e.id)
      and exists (select 1 from guild_quiz_attempts a where a.event_id = e.id and a.submitted_at is not null)
      and official_quiz_attempts_in_flight(e.id) = 0
    order by e.completed_at asc nulls first
  loop
    begin
      perform official_event_settle_locked(v_event_id, 'auto_settle_official_quiz');
      v_count := v_count + 1;
    exception when others then
      -- One bad quiz must not stop the rest. It stays 'closed'; an admin can still pay it by hand.
      raise warning 'Auto-payout for official quiz % failed: %', v_event_id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;
revoke all on function auto_settle_official_quizzes() from public, anon, authenticated;

select cron.schedule('auto-settle-official-quizzes', '*/15 * * * *', $$select auto_settle_official_quizzes();$$);
