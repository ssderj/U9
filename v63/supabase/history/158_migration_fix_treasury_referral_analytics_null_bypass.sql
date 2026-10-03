-- ============================================================================================
-- Migration 158: five latent NULL-comparison bypasses (defense-in-depth, not currently
-- anon-exploitable -- none of these five functions grant anon EXECUTE, and no anon-executable
-- function calls any of them internally either, checked across the full function set)
-- ============================================================================================
-- Same bug shape found in migrations 156/157, recurring in five more places: a bare
-- `x <> auth.uid()` / `x = auth.uid()` used as an authorization or self-check gate, which is
-- NULL (not true/false) for a signed-out caller, and a plpgsql `IF NULL THEN raise` silently
-- skips. Currently dormant because none of these five are anon-executable and no anon-reachable
-- function calls them internally (verified) -- fixed now anyway so a future grant change can't
-- silently reactivate them, exactly as happened with transfer_guild_ownership.
--
-- 1. set_guild_treasury_role: `if auth.uid() <> v_guild.owner_id` -- primary ownership gate,
--    same shape as the original transfer_guild_ownership bug.
-- 2. cancel_guild_treasury_spend_request: `if auth.uid() <> requested_by and not
--    is_guild_officer(...)` -- NULL propagates through the AND (NULL AND TRUE is NULL, not
--    TRUE), so a signed-out caller could cancel any guild's pending spend request.
-- 3. fetch_book_view_summary: `if v_author_id <> auth.uid()` -- would let a signed-out caller
--    read any book's private view analytics.
-- 4. grant_referral_reward: `if v_referral.referrer_id <> auth.uid()` -- would let a signed-out
--    caller trigger a payout on someone else's referral.
-- 5. redeem_referral_code: `if v_referrer_id = auth.uid()` self-referral guard has the same
--    NULL-bypass shape, but the real fix here is an explicit upfront auth.uid() is null check --
--    the self-referral check was never the actual security boundary for this function; being
--    signed in is. (referrals.referee_id is NOT NULL, so a signed-out call would currently fail
--    on a constraint violation rather than silently insert a row -- this makes the failure mode
--    correct on its own, but noisy/wrong-message; the explicit guard fixes both.)
--
-- Fix, minimal diff, nothing else touched in any of the five function bodies:
--   1: `if auth.uid() <> owner_id` -> `if auth.uid() is null or auth.uid() <> owner_id`
--   2: `if auth.uid() <> requested_by and not is_guild_officer(...)` ->
--      `if (auth.uid() is null or auth.uid() <> requested_by) and not is_guild_officer(...)`
--   3: `if v_author_id <> auth.uid()` -> `if auth.uid() is null or v_author_id <> auth.uid()`
--   4: `if v_referral.referrer_id <> auth.uid()` ->
--      `if auth.uid() is null or v_referral.referrer_id <> auth.uid()`
--   5: added `if auth.uid() is null then raise exception 'You must be signed in to redeem a
--      referral code.'; end if;` as the very first statement in the function body.
--
-- No grants touched -- confirmed via information_schema.role_routine_grants before this
-- migration that none of the five had anon, and this migration doesn't add or remove any grant.
--
-- Applied live 2026-09-26. Verified in a rolled-back transaction against synthetic fixtures:
-- all five now reject a simulated signed-out caller with the intended message; a real, properly
-- authorized caller (owner / requester / guild officer / book author / referral's own referrer /
-- a genuine referee redeeming someone else's code) still succeeds; an authenticated but
-- unauthorized caller (non-owner / unrelated user / wrong author / unrelated referrer / user
-- redeeming their own code) is still correctly rejected -- no regression on any positive or
-- negative authenticated case.
-- ============================================================================================

create or replace function set_guild_treasury_role(p_guild_id uuid, p_member_id uuid, p_role text)
returns player_guild_members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
  v_row player_guild_members;
begin
  if p_role not in ('treasurer', 'officer', 'member') then
    raise exception 'Role must be treasurer, officer, or member.';
  end if;

  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    raise exception 'Guild not found.';
  end if;
  if v_guild.is_founder_guild then
    raise exception 'A Founder Guild has no single leader to delegate Treasurer/Officer roles — its treasury authority is held by the Inkroot admins flagged as Founder Guild treasurers.';
  end if;
  if auth.uid() is null or auth.uid() <> v_guild.owner_id then
    raise exception 'Only the guild leader can assign treasury roles.';
  end if;
  if p_member_id = v_guild.owner_id then
    raise exception 'The guild leader''s own role cannot be changed here.';
  end if;

  update player_guild_members set role = p_role
  where guild_id = p_guild_id and user_id = p_member_id
  returning * into v_row;

  if not found then
    raise exception 'That writer is not a member of this guild.';
  end if;
  return v_row;
end;
$$;

create or replace function cancel_guild_treasury_spend_request(p_request_id uuid)
returns guild_treasury_spend_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req guild_treasury_spend_requests;
begin
  select * into v_req from guild_treasury_spend_requests where id = p_request_id for update;
  if not found then
    raise exception 'Spend request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This spend request has already been decided.';
  end if;
  if (auth.uid() is null or auth.uid() <> v_req.requested_by)
     and not is_guild_officer(v_req.guild_id) then
    raise exception 'Only the person who proposed this spend, or the guild leader, can cancel it.';
  end if;

  update guild_treasury_spend_requests set status = 'cancelled', decided_at = now()
  where id = p_request_id
  returning * into v_req;
  return v_req;
end;
$$;

create or replace function fetch_book_view_summary(p_book_id text)
returns table(total_detail_views bigint, total_read_starts bigint, unique_viewers bigint, views_by_source jsonb, daily_trend jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
begin
  select author_id into v_author_id from published_books where id = p_book_id;
  if v_author_id is null then
    raise exception 'No published book found with that id.';
  end if;
  if auth.uid() is null or v_author_id <> auth.uid() then
    raise exception 'Only this book''s own author can view its analytics.';
  end if;

  return query
  select
    (select count(*) from book_view_events where book_id = p_book_id and event_type = 'detail_view'),
    (select count(*) from book_view_events where book_id = p_book_id and event_type = 'read_start'),
    (select count(distinct viewer_id) from book_view_events where book_id = p_book_id and viewer_id is not null),
    (select coalesce(jsonb_object_agg(source, cnt), '{}'::jsonb)
       from (select source, count(*) as cnt from book_view_events where book_id = p_book_id group by source) s),
    (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day), '[]'::jsonb)
       from (
         select date_trunc('day', created_at)::date as day, count(*) as cnt
         from book_view_events
         where book_id = p_book_id and created_at > now() - interval '30 days'
         group by 1
       ) d);
end;
$$;

create or replace function grant_referral_reward(p_referral_id uuid, p_kind text)
returns referral_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral referrals%rowtype;
  v_row referral_grants;
  v_reward_kobo bigint;
  v_eligible boolean;
  v_config referral_reward_config%rowtype;
  v_lifetime_granted_kobo bigint;
  v_lifetime_reversed_kobo bigint;
  v_remaining_headroom_kobo bigint;
begin
  select * into v_referral from referrals where id = p_referral_id;
  if not found then
    raise exception 'No such referral.';
  end if;

  if auth.uid() is null or v_referral.referrer_id <> auth.uid() then
    raise exception 'Not your referral.';
  end if;

  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row;
  end if;

  if p_kind not in ('reader_purchase', 'writer_earnings', 'guild_activity') then
    raise exception 'Unknown referral reward kind.';
  end if;

  if referral_devices_linked(v_referral.referrer_id, v_referral.referee_id) then
    raise exception 'This referral is not eligible for a reward.';
  end if;

  perform pg_advisory_xact_lock(hashtext('referral_reward:' || p_referral_id::text || ':' || p_kind));
  perform pg_advisory_xact_lock(hashtext('referral_lifetime_cap:' || v_referral.referrer_id::text));

  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row;
  end if;

  case p_kind
    when 'reader_purchase' then v_eligible := referral_reader_signal(v_referral.referee_id);
    when 'writer_earnings' then v_eligible := referral_writer_signal(v_referral.referee_id);
    when 'guild_activity'  then v_eligible := referral_guild_signal(v_referral.referee_id);
  end case;

  if not coalesce(v_eligible, false) then
    raise exception 'This referral has not produced qualifying activity yet.';
  end if;

  case p_kind
    when 'reader_purchase' then v_reward_kobo := referral_reader_reward_kobo(v_referral.referee_id);
    when 'writer_earnings' then v_reward_kobo := referral_writer_reward_kobo(v_referral.referee_id);
    when 'guild_activity'  then v_reward_kobo := referral_guild_reward_kobo(v_referral.referee_id);
  end case;

  select * into v_config from referral_reward_config;

  if coalesce(v_reward_kobo, 0) > v_config.max_reward_per_referral_kobo then
    v_reward_kobo := v_config.max_reward_per_referral_kobo;
  end if;

  select coalesce(sum(g.naira_reward_kobo), 0) into v_lifetime_granted_kobo
  from referral_grants g join referrals r on r.id = g.referral_id
  where r.referrer_id = v_referral.referrer_id;

  select coalesce(sum(x.kobo_reversed), 0) into v_lifetime_reversed_kobo
  from referral_grant_reversals x
  join referral_grants g on g.id = x.referral_grant_id
  join referrals r on r.id = g.referral_id
  where r.referrer_id = v_referral.referrer_id;

  v_remaining_headroom_kobo := v_config.max_lifetime_referral_earnings_kobo
                                - (v_lifetime_granted_kobo - v_lifetime_reversed_kobo);

  if v_remaining_headroom_kobo <= 0 then
    raise exception 'This referrer has reached the lifetime referral earnings limit.';
  end if;

  if v_reward_kobo > v_remaining_headroom_kobo then
    v_reward_kobo := v_remaining_headroom_kobo;
  end if;

  if coalesce(v_reward_kobo, 0) <= 0 then
    raise exception 'No platform fee available yet to fund this referral reward.';
  end if;

  insert into referral_grants (referral_id, kind, naira_reward_kobo)
  values (p_referral_id, p_kind, v_reward_kobo)
  returning * into v_row;

  update referrals set status = 'rewarded' where id = p_referral_id and status = 'pending';

  return v_row;
end;
$$;

create or replace function redeem_referral_code(p_code text)
returns referrals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer_id uuid;
  v_row referrals;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to redeem a referral code.';
  end if;

  select * into v_row from referrals where referee_id = auth.uid();
  if found then
    return v_row;
  end if;

  select id into v_referrer_id from profiles where referral_code = lower(trim(p_code));
  if v_referrer_id is null then
    raise exception 'No account found with that referral code.';
  end if;

  if v_referrer_id = auth.uid() then
    raise exception 'You cannot refer yourself.';
  end if;

  insert into referrals (referrer_id, referee_id)
  values (v_referrer_id, auth.uid())
  on conflict (referee_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from referrals where referee_id = auth.uid();
  end if;

  return v_row;
end;
$$;
