-- Restored from live. Applied to the live database as 20260925075157 "152_migration_anon_grant_audit_followup".
-- This file was missing from the repo; the SQL below is the statement list Supabase recorded.

revoke execute on function accounts_share_device_signal(uuid, uuid) from anon;
revoke execute on function accounts_share_device_signal(uuid, uuid) from authenticated;

create or replace function guild_event_escrow_contribution_shares(p_event_id uuid)
returns table(contributor_id uuid, amount_kobo bigint, share_bps integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_guild_id uuid;
begin
  select guild_id into v_guild_id from guild_events where id = p_event_id;
  if v_guild_id is null then
    raise exception 'Guild event not found.';
  end if;
  if not (is_guild_member(v_guild_id) or is_guild_officer(v_guild_id) or is_inkroot_admin()) then
    raise exception 'Only a member of this guild can view its escrow contribution shares.';
  end if;

  return query
  with amounts as (
    select created_by as contributor_id, sum(t.amount_kobo) as amount_kobo
    from guild_treasury_transactions t
    where t.escrow_event_id = p_event_id
      and t.kind = 'event_prize_escrow_contribution'
      and t.status = 'success'
    group by created_by
  ),
  total as (
    select greatest(sum(amount_kobo), 1) as total_kobo from amounts
  ),
  raw as (
    select a.contributor_id, a.amount_kobo,
           (a.amount_kobo::numeric / t.total_kobo) * 10000 as raw_share
    from amounts a cross join total t
  ),
  based as (
    select contributor_id, amount_kobo, floor(raw_share)::integer as base,
           raw_share - floor(raw_share) as frac
    from raw
  ),
  ranked as (
    select contributor_id, amount_kobo, base, frac,
           row_number() over (order by frac desc, contributor_id) as rn,
           (10000 - sum(base) over ())::integer as remainder
    from based
  )
  select contributor_id, amount_kobo, base + case when rn <= remainder then 1 else 0 end
  from ranked;
end;
$$;

revoke execute on function guild_event_escrow_contribution_shares(uuid) from anon;
