-- 168_migration_guild_event_prize_rules.sql
--
-- Three product rules for guild-hosted events, confirmed by the app owner:
--
--   1. A guild event MUST have its prize locked in escrow. Before this, a guild could run a paid
--      event with no guaranteed prize at all (falling back to the entry-fee split in the financial
--      agreement). Now no host='guild' event can leave 'draft' without a guaranteed prize; the
--      existing checks in submit_guild_event_for_approval / activate_guild_event (migration 125 / 108)
--      then require that prize to actually be deposited. Events that are already past draft are not
--      touched — the check only fires when approval_status changes.
--
--   2. No member of the hosting guild can be paid an escrowed event's prize — the hosting guild is
--      the one paying it. compute_guild_event_placements() leaves them out of the ranking and
--      settle_guild_event() refuses them. (Whether they may still ENTER is a separate, undecided
--      question; this migration does not change entry.) Events without an escrowed prize (legacy)
--      and Inkroot-hosted events keep the original members-only rule.
--
--   3. Winners are paid automatically and directly from the escrow. The prize now lands in a new
--      guild_event_prize_payouts table that author_balance_kobo() counts, so a winner needs no guild
--      membership and no guild leader's action to withdraw it. compute_guild_event_placements()
--      settles an escrowed event as soon as placements are computed (no separate approval click).
--
-- Deliberately unchanged: the financial-agreement requirement (migration 131/167), who may ENTER an
-- event, entry-fee crediting to the guild treasury, and everything about Inkroot-hosted events.
-- Not run against a live database. Safe to apply once; functions are create-or-replace.

-- ----------------------------------------------------------------------------------------------
-- 1. Mandatory escrowed prize
-- ----------------------------------------------------------------------------------------------
create or replace function enforce_guild_event_prize_required()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.host = 'guild'
     and new.approval_status in ('pending_approval', 'approved', 'published', 'active')
     and (tg_op = 'INSERT' or new.approval_status is distinct from old.approval_status)
     and (new.guaranteed_prize_kobo is null or new.guaranteed_prize_kobo <= 0) then
    raise exception 'Every guild event must lock a prize in escrow — set a guaranteed prize and deposit it before submitting.';
  end if;
  return new;
end;
$$;

drop trigger if exists guild_events_prize_required on guild_events;
create trigger guild_events_prize_required
  before insert or update of approval_status on guild_events
  for each row execute function enforce_guild_event_prize_required();

-- ----------------------------------------------------------------------------------------------
-- 2. Where escrowed prizes are paid to winners
-- ----------------------------------------------------------------------------------------------
create table if not exists guild_event_prize_payouts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  guild_id uuid not null references player_guilds(id) on delete cascade,
  winner_id uuid not null references auth.users(id) on delete cascade,
  amount_kobo bigint not null check (amount_kobo > 0),
  created_at timestamptz not null default now(),
  unique (event_id, winner_id)
);
alter table guild_event_prize_payouts enable row level security;
drop policy if exists "winners read their own event prize payouts" on guild_event_prize_payouts;
create policy "winners read their own event prize payouts" on guild_event_prize_payouts
  for select using (winner_id = auth.uid());
-- No insert/update/delete policy: only settle_guild_event() (security definer) writes here.
create index if not exists guild_event_prize_payouts_winner_idx on guild_event_prize_payouts (winner_id);
create index if not exists guild_event_prize_payouts_guild_idx on guild_event_prize_payouts (guild_id);

-- ----------------------------------------------------------------------------------------------
-- 3. settle_guild_event, compute_guild_event_placements, author_balance_kobo
--    Each is its latest existing definition (134 / 135 / 164) with only the marked
--    "Migration 168" changes.
-- ----------------------------------------------------------------------------------------------

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_guild player_guilds%rowtype;
  v_gross bigint;
  v_entry_fees bigint;
  v_bad_contributor uuid;
  v_dup_contributor boolean;
  v_agreement guild_event_financial_agreements%rowtype;
  v_shares_sum integer;
  v_escrowed boolean;
  v_payout_gross bigint;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  select * into v_guild from player_guilds where id = p_guild_id;

  if v_event.host = 'guild' then
    -- Migration 168: compute_guild_event_placements() settles an escrowed event automatically
    -- and has already authorized ITS caller (organizer / guild authority / Inkroot). It marks the
    -- transaction with this event's id; nothing a client can reach sets it, and this function is
    -- revoked from every client role.
    if not is_guild_treasury_authorized(p_guild_id)
       and coalesce(current_setting('inkroot.auto_settle_event', true), '') <> p_event_id::text then
      raise exception 'Only the guild leader, a treasurer, or an officer can settle this event.';
    end if;
  else -- 'inkroot'
    -- Migration 122: restores the is_inkroot_admin() app path alongside the original
    -- null-session/service-role path — see that migration's header, point 3b.
    if auth.uid() is not null and not is_inkroot_admin() then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  -- Migration 120: take the SAME lock key create_guild_event_entry_locked/
  -- cancel_guild_event/admin_cancel_guild_event_dispute use, in the same entry-then-
  -- settlement order those functions now all use, before this function's own settlement
  -- lock — see this migration's header. Closes the race where a concurrent cancellation
  -- and settlement could each pass their own "not already settled/cancelled" check on
  -- different, uncoordinated lock keys and both commit, double-releasing an escrowed prize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
  end if;
  -- Migration 120: a host='guild' event previously had no state-machine gate here at all
  -- beyond "not settled/cancelled" — it could be settled (and an escrowed guaranteed
  -- prize paid out) while still 'draft'/'pending_approval'/'approved'/'published', i.e.
  -- before Inkroot ever reviewed it, before it ever opened for entries, and before it ran
  -- at all. Requiring 'active' or 'completed' (the same two states the app's own settlement
  -- UI already assumes — see guild-events-panel.jsx) closes that: a guaranteed prize can
  -- only be escrowed and then settled once the event has actually gone live.
  if v_event.host = 'guild' and v_event.approval_status not in ('active', 'completed') then
    raise exception 'This event must be active or completed before it can be settled.';
  end if;

  v_escrowed := v_event.host = 'guild'
    and v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;

  if v_escrowed then
    -- Migration 168: the hosting guild is the one PAYING an escrowed prize — none of its members
    -- may be paid it.
    select (s->>'contributor_id')::uuid into v_bad_contributor
    from jsonb_array_elements(p_shares) s
    where exists (
      select 1 from player_guild_members m
      where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
    )
    limit 1;
    if v_bad_contributor is not null then
      raise exception 'A member of the hosting guild cannot be paid this event''s prize.';
    end if;
  else
    select (s->>'contributor_id')::uuid into v_bad_contributor
    from jsonb_array_elements(p_shares) s
    where not exists (
      select 1 from player_guild_members m
      where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
    )
    limit 1;
    if v_bad_contributor is not null then
      raise exception 'Every winner must be a member of this guild.';
    end if;
  end if;

  -- Migration 134: the same contributor cannot be declared more than one winner slot in a
  -- single settlement. Not a financial exploit on its own (the bps total is still capped
  -- below), but it lets one person collect multiple placements' worth of "winner" standing,
  -- which the product's declared-results model doesn't intend. This is the authoritative
  -- check — submit_guild_event_results() also rejects this earlier for a friendlier error,
  -- but every caller of settle_guild_event() (computed, organizer-submitted, or any future
  -- path) is covered here regardless.
  select exists (
    select 1 from jsonb_array_elements(p_shares) s
    group by (s->>'contributor_id')
    having count(*) > 1
  ) into v_dup_contributor;
  if v_dup_contributor then
    raise exception 'The same person cannot be declared as more than one winner slot.';
  end if;

  if v_event.host = 'guild' then
    select coalesce(sum(net_kobo), 0) into v_entry_fees
    from guild_event_entries where event_id = p_event_id and status = 'success';

    if v_escrowed then
      -- The full escrowed amount goes to the declared winners — no financial-agreement skim.
      -- Entry fees are entirely separate Event Revenue Pool income (credited below), never
      -- split with winners here.
      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> 10000 then
        raise exception 'A guaranteed prize is paid to winners in full — declared shares must add up to exactly 100%%.';
      end if;
      v_gross := v_event.guaranteed_prize_kobo;
    else
      select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
      if not found or not v_agreement.locked then
        raise exception 'This event has no locked financial agreement — it cannot be settled.';
      end if;

      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> v_agreement.prize_pool_bps then
        raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
      end if;

      v_gross := v_entry_fees;
    end if;
  else
    -- Migration 122: an Inkroot-hosted prize for a Founder Guild must go entirely to named
    -- winners — no leftover may become a "guild share" credit, since a Founder Guild has no
    -- treasury bucket to hold one. A Player Guild target is unaffected.
    if v_guild.is_founder_guild then
      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> 10000 then
        raise exception 'An Inkroot-hosted prize for a Founder Guild must be declared 100%% to named winners — a Founder Guild has no treasury to hold a leftover share.';
      end if;
    end if;
    v_gross := v_event.cash_prize_kobo;
  end if;

  if v_escrowed then
    -- Migration 168: an escrowed prize goes straight to each winner's own withdrawable balance
    -- (see author_balance_kobo) at settlement — no held-in-guild-treasury step and no guild
    -- membership needed to withdraw it. Largest-remainder rounding, same method
    -- distribute_guild_revenue() uses, so the payouts add up to exactly the escrowed amount.
    v_payout_gross := v_gross;
    with shares as (
      select (s->>'contributor_id')::uuid as winner_id, (s->>'share_bps')::integer as share_bps
      from jsonb_array_elements(p_shares) s
      where (s->>'share_bps')::integer > 0
    ),
    amounts as (
      select winner_id,
        floor(v_payout_gross * share_bps::numeric / 10000)::bigint as base,
        (v_payout_gross * share_bps::numeric / 10000) - floor(v_payout_gross * share_bps::numeric / 10000) as frac
      from shares
    ),
    ranked as (
      select winner_id, base,
        row_number() over (order by frac desc, winner_id) as rn,
        (v_payout_gross - sum(base) over ())::bigint as leftover
      from amounts
    )
    insert into guild_event_prize_payouts (event_id, guild_id, winner_id, amount_kobo)
    select p_event_id, p_guild_id, winner_id, base + case when rn <= leftover then 1 else 0 end
    from ranked
    where base + case when rn <= leftover then 1 else 0 end > 0;
  else
    perform distribute_guild_revenue(
      p_guild_id := p_guild_id,
      p_gross_amount_kobo := v_gross,
      p_shares := p_shares,
      p_kind := 'event_revenue',
      p_source := 'event_sale',
      p_source_purchase_id := null,
      p_anthology_id := null,
      p_project_event_id := p_event_id,
      p_title := 'Guild event — ' || v_event.title
    );
  end if;

  if v_event.host = 'guild' and v_escrowed and v_entry_fees > 0 then
    insert into guild_treasury_transactions
      (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
       project_event_id, status, title)
    values
      (p_guild_id, 'guild', null, 'credit', 'event_entry_revenue', v_entry_fees, 'NGN',
       'event_sale', 'guild_treasury', p_event_id, 'success',
       'Guild event entry fees — ' || v_event.title);
  end if;

  -- Migration 113: close an Inkroot-hosted event's prize reservation as paid (no-op for an event
  -- created before the reserve existed — see the migration header).
  if v_event.host = 'inkroot' then
    perform platform_reserve_record_settlement(p_event_id);
  end if;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public, anon, authenticated;

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
    if v_assigned_count < 3 then
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
  -- on the server from locked rules), so there is nothing left for an approver to decide. NOTE: the
  -- judge-exclusion recompute (p_exclude_judge_ids) is therefore only possible BEFORE this first
  -- successful compute, since a settled event cannot be recomputed.
  if v_escrowed then
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

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
declare
  v_ids uuid[];
begin
  if check_user_id is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  select array_agg(secondary_id) into v_ids from linked_profiles where main_id = check_user_id;
  v_ids := array_append(coalesce(v_ids, array[]::uuid[]), check_user_id);

  return
    -- Sales (anthology-book purchases are excluded: their share is distributed through the guild
    -- treasury instead — migration 37). Earning side: expanded to v_ids.
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = any(v_ids) and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    -- Spending side: withdrawals always belong to the main account only.
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    -- Spending side: a guild-treasury contribution is money leaving the contributor's own
    -- balance — left as check_user_id only, same reasoning as withdrawals above.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    -
    -- Migration 131: a locked-in escrow contribution leaves the contributor's own balance —
    -- spending side, same as the contribution term above.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'event_prize_escrow_contribution'
                and status in ('pending', 'success')), 0)
    +
    -- Earning side: expanded to v_ids.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = any(v_ids) and kind = 'release_to_member' and status = 'success'), 0)
    +
    -- Migration 131: an escrow refund or payout comes back into the contributor's balance —
    -- earning side, expanded to v_ids.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = any(v_ids)
                and kind in ('event_prize_escrow_contributor_refund', 'event_prize_escrow_contributor_payout')
                and status = 'success'), 0)
    +
    -- Migration 168: guild-event prizes paid straight from escrow to the winner — earning side,
    -- expanded to v_ids like every other earning term.
    coalesce((select sum(amount_kobo) from guild_event_prize_payouts
              where winner_id = any(v_ids)), 0)
    +
    -- Migration 52 / 110: achievement Naira grants, net of reversals — earning side, expanded.
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = any(v_ids)), 0)
    -
    coalesce((select sum(x.kobo_reversed) from achievement_grant_reversals x
              join achievement_grants ag on ag.id = x.achievement_grant_id
              where ag.user_id = any(v_ids)), 0)
    +
    -- Migration 56 / 58: referral Naira grants, net of reversals — earning side, expanded.
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = any(v_ids)), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = any(v_ids)), 0);
end;
$$ language plpgsql stable security definer set search_path = public;
revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
