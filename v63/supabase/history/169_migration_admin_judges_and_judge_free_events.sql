-- 169_migration_admin_judges_and_judge_free_events.sql
--
-- Judging and entry rules for the new guild event types, confirmed by the app owner:
--
--   1. JUDGES ARE INKROOT ADMINS. assign_guild_event_judges() now seats profiles with
--      is_platform_admin (unpaid — a feature for now) instead of random verified authors. An admin
--      who is the event's organizer/creator or belongs to the hosting guild is skipped. The
--      minimum panel is a setting (guild_event_judging_settings, default 3, floor 2 because
--      guild_event_judge_quorum() never goes below 2) so a small team isn't locked out.
--   2. JUDGED EVENTS ARE COMPUTED BY INKROOT ONLY, and are NOT auto-paid. Migration 168 settles an
--      escrowed event the instant placements are computed, which made a bad judge's scores
--      impossible to exclude afterwards. Now only a judge-free event pays on compute; a judged one
--      stays 'computed' until an admin calls settle_computed_guild_event() (recompute with
--      p_exclude_judge_ids is possible any number of times before that).
--   3. JUDGE-FREE EVENTS. giveaway / reading_challenge (quiz) / tournament get a locked config at
--      activation with metric giveaway_draw / quiz_score / tournament_bracket at weight 10000 —
--      no judges. Their actual draw / grading / bracket functions come in later migrations, so
--      guild_event_type_backend_ready() keeps them from opening until each one ships.
--   4. HOST-GUILD MEMBERS CAN NEVER ENTER THEIR OWN GUILD'S EVENTS (create_guild_event_entry_locked).
--      The rule that a question's writer can't enter an event using their question arrives with
--      the question-bank tables (guild_quiz_questions doesn't exist yet).
--
-- Deliberately unchanged: the 168 rule that host-guild members are left out of an escrowed
-- event's ranking (still the backstop for anyone who entered before this migration).
-- Not run against a live database (none available when written). Safe to apply once; functions
-- are create-or-replace, the constraints are dropped and re-added by definition.

-- 1. Allow the three judge-free metrics, and require them to carry full weight.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'guild_event_objective_config'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%metric%'
  loop
    execute format('alter table guild_event_objective_config drop constraint %I', c.conname);
  end loop;
end $$;

alter table guild_event_objective_config
  add constraint guild_event_objective_config_metric_check
    check (metric in ('none', 'word_count', 'on_time_completion', 'giveaway_draw', 'quiz_score', 'tournament_bracket')),
  add constraint guild_event_objective_config_none_needs_zero_weight
    check (metric <> 'none' or weight_bps = 0),
  add constraint guild_event_objective_config_judge_free_full_weight
    check (metric not in ('giveaway_draw', 'quiz_score', 'tournament_bracket') or weight_bps = 10000);

-- 2. Event-type helpers.
create or replace function guild_event_judge_free_metric(p_event_type text)
returns text as $$
  select case p_event_type
    when 'giveaway' then 'giveaway_draw'
    when 'reading_challenge' then 'quiz_score'
    when 'tournament' then 'tournament_bracket'
    else null
  end;
$$ language sql immutable;

-- Every judge-free type is false until its own migration flips it (167-170 series).
create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then false
    when 'reading_challenge' then false
    when 'tournament' then false
    else true
  end;
$$ language sql immutable;

revoke all on function guild_event_judge_free_metric(text) from public, anon, authenticated;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;

-- 3. Minimum judge panel, adjustable by an admin.
create table if not exists guild_event_judging_settings (
  id boolean primary key default true check (id),
  min_judges integer not null default 3 check (min_judges >= 2),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table guild_event_judging_settings enable row level security;
-- No policies: read through guild_event_min_judges(), written through the admin function below.
insert into guild_event_judging_settings (id) values (true) on conflict (id) do nothing;

create or replace function guild_event_min_judges()
returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((select min_judges from guild_event_judging_settings where id), 3);
$$;
revoke all on function guild_event_min_judges() from public, anon, authenticated;

create or replace function admin_set_guild_event_min_judges(p_min_judges integer)
returns integer
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can change this.';
  end if;
  if p_min_judges is null or p_min_judges < 2 then
    raise exception 'A judged event needs at least 2 judges.';
  end if;
  update guild_event_judging_settings set min_judges = p_min_judges, updated_by = auth.uid(), updated_at = now() where id;
  return p_min_judges;
end;
$$;
revoke all on function admin_set_guild_event_min_judges(integer) from public, anon;
grant execute on function admin_set_guild_event_min_judges(integer) to authenticated;

-- 4. Admin judges.
create or replace function assign_guild_event_judges(p_event_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_seated integer;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if exists (select 1 from guild_event_judges where event_id = p_event_id) then
    return (select count(*)::integer from guild_event_judges where event_id = p_event_id);
  end if;

  insert into guild_event_judges (event_id, judge_id)
  select p_event_id, p.id
  from profiles p
  where p.is_platform_admin
    and not is_banned(p.id)
    and p.id <> coalesce(v_event.organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and p.id <> coalesce(v_event.created_by, '00000000-0000-0000-0000-000000000000'::uuid)
    and not exists (
      select 1 from player_guild_members m where m.guild_id = v_event.guild_id and m.user_id = p.id
    )
    and not exists (
      select 1 from player_guilds g where g.id = v_event.guild_id and g.owner_id = p.id
    )
  order by random()
  limit guild_event_judge_panel_size();

  select count(*) into v_seated from guild_event_judges where event_id = p_event_id;
  if v_seated < guild_event_min_judges() then
    delete from guild_event_judges where event_id = p_event_id;
    raise exception 'Not enough Inkroot admins are free to judge this event (need at least %, found %).', guild_event_min_judges(), v_seated;
  end if;
  return v_seated;
end;
$$;
revoke all on function assign_guild_event_judges(uuid) from public, anon, authenticated;

-- 5. activate_guild_event — migration 167's body with the type gate and the judge-free config.
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

  -- Migration 169: these event types can't open until their backend exists (each later migration
  -- flips its own type to ready in guild_event_type_backend_ready()).
  if v_event.host = 'guild' and not guild_event_type_backend_ready(v_event.event_type) then
    raise exception 'This kind of event isn''t available to open yet.';
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
    if guild_event_judge_free_metric(v_event.event_type) is not null then
      -- Migration 169: giveaway / quiz / tournament winners come from the draw, the score or the
      -- bracket — never from judges. Whatever judging setup the host saved is replaced by the
      -- judge-free one (their placement split is kept), locked, with no judges assigned.
      insert into guild_event_objective_config
        (event_id, guild_id, metric, weight_bps, locked, locked_at, created_by)
      values (p_event_id, p_guild_id, guild_event_judge_free_metric(v_event.event_type), 10000, true, now(), auth.uid())
      on conflict (event_id) do update set
        metric = excluded.metric, weight_bps = 10000, locked = true, locked_at = now(), updated_at = now();
    else
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
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function activate_guild_event(uuid, uuid) from public;
grant execute on function activate_guild_event(uuid, uuid) to authenticated;

-- 6. compute_guild_event_placements — migration 168's body with the two 169 changes marked.
create or replace function compute_guild_event_placements(p_event_id uuid, p_exclude_judge_ids uuid[] default '{}')
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_guild_id uuid;
  v_objective guild_event_objective_config%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_assigned_count integer;
  v_quorum integer;
  v_min_scored integer;
  v_max_word_count integer;
  v_escrowed boolean;
  v_pool_bps integer;
  v_placements jsonb;
  v_row guild_event_results%rowtype;
begin
  -- Audit fix: a NULL array made "judge_id <> all (NULL)" evaluate to NULL, silently dropping EVERY
  -- judge score from the computation (and skipping the admin-only check above). Treat it as empty.
  p_exclude_judge_ids := coalesce(p_exclude_judge_ids, '{}');
  if p_exclude_judge_ids <> '{}' and not is_inkroot_admin() then
    raise exception 'Only Inkroot can exclude a judge''s scores from a computation.';
  end if;

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  v_guild_id := v_event.guild_id;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;

  -- Migration 135: the organizer, a guild treasury authority, or Inkroot — see this migration's
  -- header. Matches the caller set migration 121's own comment already described but never
  -- actually enforced.
  if not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_guild_id)
    or is_inkroot_admin()
  ) then
    raise exception 'Only this event''s organizer, a guild authority, or Inkroot can compute its placements.';
  end if;

  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before computing placements.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  select * into v_objective from guild_event_objective_config where event_id = p_event_id;
  if not found or not v_objective.locked then
    raise exception 'This event has no locked judging configuration — it cannot be settled.';
  end if;

  -- Migration 169: a judged event (any weight left on the judge panel) is computed by Inkroot only.
  -- The judges are Inkroot admins, and Inkroot must be able to drop a judge's scores and recompute
  -- BEFORE any money moves — the organizer triggering the computation could otherwise force an
  -- immediate payout (migration 168 auto-settles). Judge-free events are unaffected.
  if v_objective.weight_bps < 10000 and not is_inkroot_admin() then
    raise exception 'Results for a judged event are computed by Inkroot, not by the host guild.';
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;
  if not v_escrowed then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;
  end if;
  -- settle_guild_event() requires shares to sum to EXACTLY v_agreement.prize_pool_bps
  -- (non-escrowed) or 10000 (escrowed, paid in full — see its own header). placement_split_bps
  -- sums to 10000 at proposal time (a proportional split of "the prize pool", whatever it turns
  -- out to be) so it's scaled against v_pool_bps below, never used as the final share directly.
  v_pool_bps := case when v_escrowed then 10000 else v_agreement.prize_pool_bps end;

  if not exists (select 1 from guild_event_submissions where event_id = p_event_id) then
    raise exception 'No submissions were received for this event.';
  end if;

  -- ---- Judge quorum check (skipped entirely for a pure-objective event) ----
  if v_objective.weight_bps < 10000 then
    select count(*) into v_assigned_count
    from guild_event_judges where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids);
    if v_assigned_count < guild_event_min_judges() then
      raise exception 'Too few judges remain eligible for this event to reach quorum.';
    end if;
    v_quorum := guild_event_judge_quorum(v_assigned_count);

    select min(scored_by) into v_min_scored from (
      select s.id, count(distinct sc.judge_id) as scored_by
      from guild_event_submissions s
      left join guild_event_judge_scores sc
        on sc.submission_id = s.id and sc.judge_id <> all (p_exclude_judge_ids)
      where s.event_id = p_event_id
      group by s.id
    ) counts;
    if v_min_scored is null or v_min_scored < v_quorum then
      raise exception 'Judging quorum not yet met — at least % of % judges must score every entry (lowest so far: %).',
        v_quorum, v_assigned_count, coalesce(v_min_scored, 0);
    end if;
  end if;

  -- ---- Ranked scoring ----
  select max(word_count) into v_max_word_count from guild_event_submissions where event_id = p_event_id;

  with judge_avg as (
    -- Each judge's own average across categories for a submission, first — a judge who scores
    -- three categories doesn't get 3x the weight of one who scores a single overall category.
    select submission_id, judge_id, avg(score) as avg_score
    from guild_event_judge_scores
    where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids)
    group by submission_id, judge_id
  ),
  judge_counts as (
    select submission_id, count(*) as n_judges from judge_avg group by submission_id
  ),
  ranked_judges as (
    select ja.submission_id, ja.avg_score, jc.n_judges,
      row_number() over (partition by ja.submission_id order by ja.avg_score) as rn
    from judge_avg ja join judge_counts jc on jc.submission_id = ja.submission_id
  ),
  trimmed as (
    -- Trimmed mean across judges: drop the single highest and lowest when there are enough
    -- judges to still leave at least 3 in the middle (1 < rn < n_judges), so one outlier score
    -- (bribed, biased, or just careless) can't swing a placement on its own.
    select submission_id,
      case when n_judges >= 5
        then avg(avg_score) filter (where rn > 1 and rn < n_judges)
        else avg(avg_score)
      end as judge_score
    from ranked_judges
    group by submission_id, n_judges
  ),
  objective as (
    select s.id as submission_id,
      case v_objective.metric
        when 'word_count' then
          case when coalesce(v_max_word_count, 0) = 0 then 0
          else round(100.0 * s.word_count / v_max_word_count, 2) end
        when 'on_time_completion' then
          case when v_event.end_date is null or s.submitted_at <= v_event.end_date then 100 else 0 end
        else 0
      end as objective_score
    from guild_event_submissions s
    where s.event_id = p_event_id
  ),
  scored as (
    select s.id as submission_id, s.entrant_id, s.submitted_at,
      coalesce(t.judge_score, 0) as judge_score,
      coalesce(o.objective_score, 0) as objective_score,
      coalesce(t.judge_score, 0) * (10000 - v_objective.weight_bps) / 10000.0
        + coalesce(o.objective_score, 0) * v_objective.weight_bps / 10000.0 as final_score
    from guild_event_submissions s
    left join trimmed t on t.submission_id = s.id
    left join objective o on o.submission_id = s.id
    where s.event_id = p_event_id
      -- Same "winners must be guild members" rule settle_guild_event() has always enforced
      -- (see 42_migration_guild_events.sql) — an outside entrant can compete and be ranked for
      -- the record, but only a member of the hosting guild can actually be paid a placement.
      -- Migration 168: for an escrowed event the hosting guild is the payer, so its own members are
      -- left out of the ranking entirely; every other kind of event keeps the original rule.
      and (
        case when v_escrowed
          then not exists (select 1 from player_guild_members m where m.guild_id = v_guild_id and m.user_id = s.entrant_id)
          else exists (select 1 from player_guild_members m where m.guild_id = v_guild_id and m.user_id = s.entrant_id)
        end
      )
  ),
  ranked as (
    select submission_id, entrant_id, final_score, objective_score,
      row_number() over (order by final_score desc, objective_score desc, submitted_at asc) as place
    from scored
  ),
  -- Scale each declared placement_split_bps entry (sums to 10000, "100% of the prize pool")
  -- against v_pool_bps (the actual share_bps total settle_guild_event() requires), floored, so
  -- no rounding can ever push the total over v_pool_bps.
  awarded as (
    select r.place, r.entrant_id,
      (((elem->>'share_bps')::integer * v_pool_bps) / 10000) as raw_share_bps
    from ranked r
    join jsonb_array_elements(v_objective.placement_split_bps) elem
      on (elem->>'place')::integer = r.place
  ),
  final_shares as (
    -- The floor above can leave a few basis points short of v_pool_bps — settle_guild_event()
    -- requires an EXACT match, so the shortfall is added to 1st place (deterministic, declared
    -- up front in this comment, never a discretionary choice at settlement time).
    select place, entrant_id,
      raw_share_bps + case when place = (select min(place) from awarded)
        then v_pool_bps - (select coalesce(sum(raw_share_bps), 0) from awarded)
        else 0
      end as share_bps
    from awarded
  )
  select jsonb_agg(jsonb_build_object(
    'contributor_id', entrant_id, 'place', place, 'share_bps', share_bps
  ) order by place)
  into v_placements
  from final_shares
  where share_bps > 0;

  if v_placements is null or jsonb_array_length(v_placements) = 0 then
    raise exception 'No eligible entrant placed — nothing to settle.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (v_guild_id, p_event_id, v_placements, 'computed', null, now())
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'computed', submitted_by = null, submitted_at = now(),
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;

  -- Migration 168: an escrowed prize is paid automatically as soon as the placements are computed —
  -- winners no longer wait on a guild leader's approval click. The result is deterministic (computed
  -- on the server from locked rules), so there is nothing left for an approver to decide. (Migration 169: this now
  -- applies to judge-free events only, so judge exclusion + recompute stays possible on judged ones.)
  -- Migration 169: only a judge-free event (weight_bps = 10000: a draw, a quiz score, a bracket) is
  -- paid the moment it is computed. A judged event stays 'computed' so Inkroot can exclude a judge and
  -- recompute; it is paid by settle_computed_guild_event() below once Inkroot is satisfied.
  if v_escrowed and v_objective.weight_bps = 10000 then
    perform set_config('inkroot.auto_settle_event', p_event_id::text, true);
    perform settle_guild_event(
      v_guild_id, p_event_id,
      (select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
       from jsonb_array_elements(v_placements) p)
    );
    perform set_config('inkroot.auto_settle_event', '', true);
    update guild_event_results
      set status = 'approved', reviewed_by = null, reviewed_at = now(), settled_at = now()
      where event_id = p_event_id
      returning * into v_row;
  end if;
  return v_row;
end;
$$;

revoke all on function compute_guild_event_placements(uuid, uuid[]) from public;
grant execute on function compute_guild_event_placements(uuid, uuid[]) to authenticated;

-- 7. Paying a computed, judged event — Inkroot admin only, after any judge exclusion.
create or replace function settle_computed_guild_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_result guild_event_results%rowtype;
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
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;
revoke all on function settle_computed_guild_event(uuid) from public, anon;
grant execute on function settle_computed_guild_event(uuid) to authenticated;

-- 8. Entry: host-guild members are refused (patch marked "Migration 169" inside).
create or replace function create_guild_event_entry_locked(
  p_user_id uuid, p_event_id uuid, p_paystack_reference text, p_amount_kobo bigint, p_net_kobo bigint
)
returns guild_event_entries
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_entries%rowtype;
  v_row guild_event_entries;
  v_count integer;
  v_had_existing boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  if is_linked_profile(p_user_id) then
    raise exception 'Linked profiles can''t enter Guild Events.';
  end if;

  -- Migration 169: nobody who belongs to the hosting guild (member, officer or owner) may ever enter
  -- its events — the guild is the one paying the prize. Linked profiles are already refused above,
  -- so an alt can't be used to get around this.
  if exists (
    select 1 from guild_events e
    where e.id = p_event_id
      and (
        exists (select 1 from player_guild_members m where m.guild_id = e.guild_id and m.user_id = p_user_id)
        or exists (select 1 from player_guilds g where g.id = e.guild_id and g.owner_id = p_user_id)
      )
  ) then
    raise exception 'Members of the hosting guild can''t enter their own guild''s events.';
  end if;

  -- Same lock key settle_guild_event() uses for this event — an entry can't be created mid-
  -- settlement, and two simultaneous entry attempts for the same event now fully serialize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'This event has no entry fee to pay.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'This event is no longer taking entries.';
  end if;
  -- Migration 129: a hard stop independent of status/approval_status, which only get flipped by
  -- complete_guild_event() (manual) or close_ended_guild_events() (hourly cron) — neither of
  -- which is instantaneous with the clock ticking past end_date.
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This event''s entry period has ended.';
  end if;

  select * into v_existing from guild_event_entries
  where event_id = p_event_id and entrant_id = p_user_id;
  -- FOUND is reset by every later SELECT INTO (the participant-limit count below), so it is
  -- captured here instead of being re-read further down.
  v_had_existing := found;

  if v_had_existing and v_existing.status not in ('pending', 'failed') then
    raise exception 'You''ve already entered this event.';
  end if;

  -- Their own unfinished checkout: same slot, new reference. No limit check — they already hold it.
  if v_had_existing and v_existing.status = 'pending' then
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, created_at = now()
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  if v_had_existing then
    -- A previously failed attempt: re-open it rather than violating unique (event_id, entrant_id).
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, status = 'pending', created_at = now(), paid_at = null
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status)
  values (p_event_id, p_user_id, p_paystack_reference, p_amount_kobo, p_net_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;
revoke all on function create_guild_event_entry_locked(uuid, uuid, text, bigint, bigint) from public;
