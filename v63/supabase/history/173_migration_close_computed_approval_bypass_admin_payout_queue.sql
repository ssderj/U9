-- 173_migration_close_computed_approval_bypass_admin_payout_queue.sql
--
-- Found in the pre-implementation audit of migrations 167-172. Three things, all about who can move
-- a computed event's prize money and whether it leaves a trace:
--
--   1. BYPASS CLOSED. Migration 169 made a judged event's payout an Inkroot-admin-only step
--      (settle_computed_guild_event), so an admin can drop a judge's scores and recompute BEFORE any
--      money moves. But approve_guild_event_results() (migration 121) was never narrowed: it still
--      accepts a 'computed' row and lets ANY guild leader / treasurer / officer of the hosting guild
--      settle it. The front-end hides that button, but the function is granted to every signed-in user,
--      so a host-guild authority could call it directly and pay a judged event out on their own,
--      skipping the admin step and the judge-exclusion window. It now refuses a 'computed' row, and
--      refuses any event that has a judging configuration at all. Only the legacy path survives:
--      an organizer-submitted 'pending_approval' row on an event that predates migration 167 (no
--      config row), with its original four-eyes rule (the submitter can't also approve).
--      Judge-free events (giveaway, quiz, tournament) never reach this function: they are computed and
--      paid in one transaction, so no 'computed' row is ever left waiting.
--
--   2. AUDIT TRAIL RESTORED. Migration 114 made approve_guild_event_results() write an
--      admin_audit_log row (it moves real money). Migration 121 redefined the function to add the
--      'computed' branch and silently dropped that logging. It is back here. settle_computed_guild_event()
--      (migration 169) never logged at all; it does now, with the amount actually paid read back from
--      guild_event_prize_payouts rather than re-derived.
--
--   3. ADMIN PAYOUT QUEUE. Nothing in the app could list the judged events waiting on an admin, so the
--      only way to pay one was the SQL editor. admin_list_computed_guild_events() returns them (admin
--      only), with the ranked winners and how many judges are assigned, for the admin screen to build on.
--      No money moves in it.
--
-- Not run against a live database. Safe to apply once; every function is create-or-replace.

-- 1 + 2. approve_guild_event_results ---------------------------------------------------------
create or replace function approve_guild_event_results(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
  v_event guild_events%rowtype;
  v_shares jsonb;
  v_paid bigint;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been submitted for this event yet.';
  end if;
  if v_results.status = 'approved' then
    raise exception 'These results have already been approved.';
  end if;
  if v_results.status = 'computed' then
    raise exception 'Computed results are paid by Inkroot, not approved by the hosting guild.';
  end if;
  if v_results.status <> 'pending_approval' then
    raise exception 'These results were rejected — the organizer must resubmit before they can be approved.';
  end if;
  -- Any event with a judging configuration (every event activated since migration 167) is computed,
  -- never organizer-declared. Belt and braces: submit_guild_event_results() already refuses these.
  if exists (select 1 from guild_event_objective_config where event_id = p_event_id) then
    raise exception 'This event uses computed placements — organizer-declared results can''t be approved for it.';
  end if;

  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can approve event results.';
  end if;
  if auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also approve them.';
  end if;

  select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
  into v_shares
  from jsonb_array_elements(v_results.placements) p;

  -- The one call that moves money; every check settle_guild_event() makes still applies in full.
  v_event := settle_guild_event(v_results.guild_id, p_event_id, v_shares);

  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  -- Migration 114's audit row, restored: the amount is whatever settle_guild_event() just ledgered.
  select coalesce(sum(amount_kobo), 0) into v_paid from guild_treasury_transactions
  where project_event_id = p_event_id and kind = 'event_revenue' and status = 'success';

  perform record_admin_action('approve_guild_event_results', 'guild_event_results', p_event_id,
    jsonb_build_object('status', v_results.status),
    jsonb_build_object('status', 'approved', 'event_status', v_event.status, 'guild_id', v_results.guild_id),
    nullif(v_paid, 0), null);
  return v_event;
end;
$$;
revoke all on function approve_guild_event_results(uuid) from public, anon;
grant execute on function approve_guild_event_results(uuid) to authenticated;

-- 2. settle_computed_guild_event: same behaviour as migration 169, plus an audit row ------------
create or replace function settle_computed_guild_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_result guild_event_results%rowtype;
  v_paid bigint;
begin
  if auth.uid() is null or not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can pay out a judged event.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.host <> 'guild' then
    raise exception 'Guild event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  select * into v_result from guild_event_results where event_id = p_event_id for update;
  if not found or v_result.status <> 'computed' then
    raise exception 'Compute this event''s placements before paying it out.';
  end if;

  perform set_config('inkroot.auto_settle_event', p_event_id::text, true);
  perform settle_guild_event(
    v_event.guild_id, p_event_id,
    (select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
     from jsonb_array_elements(v_result.placements) p)
  );
  perform set_config('inkroot.auto_settle_event', '', true);

  update guild_event_results
    set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
    where event_id = p_event_id;

  select coalesce(sum(amount_kobo), 0) into v_paid from guild_event_prize_payouts where event_id = p_event_id;
  perform record_admin_action('settle_computed_guild_event', 'guild_event_results', p_event_id,
    jsonb_build_object('status', 'computed'),
    jsonb_build_object('status', 'approved', 'guild_id', v_event.guild_id),
    nullif(v_paid, 0), null);

  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;
revoke all on function settle_computed_guild_event(uuid) from public, anon;
grant execute on function settle_computed_guild_event(uuid) to authenticated;

-- 3. The admin payout queue ---------------------------------------------------------------------
-- Judged events whose placements have been computed but not yet paid. Read-only. computed_at is the
-- results row's submitted_at (compute_guild_event_placements() stamps it when it writes the row).
create or replace function admin_list_computed_guild_events()
returns table (
  event_id uuid, guild_id uuid, guild_name text, title text, event_type text,
  computed_at timestamptz, prize_kobo bigint, judge_count integer, placements jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can see the payout queue.';
  end if;
  return query
    select e.id, e.guild_id, g.name, e.title, e.event_type,
      r.submitted_at, e.guaranteed_prize_kobo,
      (select count(*) from guild_event_judges j where j.event_id = e.id)::integer,
      -- Winner names are the ones the app already shows for a person: pen name if set, else display name.
      (select coalesce(jsonb_agg(jsonb_build_object(
          'contributor_id', p->>'contributor_id',
          'place', p->'place',
          'share_bps', p->'share_bps',
          'name', coalesce(pr.pen_name, pr.display_name)
        ) order by (p->>'place')::integer), '[]'::jsonb)
       from jsonb_array_elements(r.placements) p
       left join profiles pr on pr.id = (p->>'contributor_id')::uuid)
    from guild_event_results r
    join guild_events e on e.id = r.event_id
    join player_guilds g on g.id = e.guild_id
    where r.status = 'computed' and e.status <> 'settled' and e.host = 'guild'
    order by r.submitted_at;
end;
$$;
revoke all on function admin_list_computed_guild_events() from public, anon;
grant execute on function admin_list_computed_guild_events() to authenticated;

-- ============================================================================================
-- Verify after applying (extends supabase/tests/167-171_two_account_checklist.md, section 2):
--   * Judged event computed by Admin (status 'computed'). As Host (guild leader), call
--     approve_guild_event_results('<id>') → refused ("paid by Inkroot"). Nothing settles.
--   * As Admin, admin_list_computed_guild_events() lists it with placements and judge_count; as
--     Host or Player it is refused. After settle_computed_guild_event('<id>') it no longer appears
--     and admin_audit_log has a 'settle_computed_guild_event' row with amount_kobo = the prize.
--   * Legacy path: an event with NO guild_event_objective_config row and an organizer-submitted
--     'pending_approval' row is still approved by a different guild authority, and now writes an
--     'approve_guild_event_results' audit row (it did not after migration 121).
-- ============================================================================================
