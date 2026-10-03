-- ============================================================================================
-- Migration 162: linked_profiles — admin-only pseudonymous secondary accounts
-- ============================================================================================
-- Lets one main account (auth.users row) have secondary, pseudonymous accounts linked to it.
-- A linked profile is a REAL, separate auth.users row with its own normal profiles row — every
-- existing table/policy/RPC that keys off profiles.id/auth.uid() already works for it with zero
-- changes. This migration only adds the record of which accounts are linked to which; the actual
-- gating (Player Guild functions), money routing (author_balance_kobo), and ban cascade are
-- separate migrations (163/164/165) layered on top of this table.
--
-- Creation is gated to platform admins for now (see supabase/functions/create-linked-profile) —
-- this table has no client insert/update/delete policy at all, so that Edge Function and
-- service_role are the only writers regardless of what the client sends. Also adds the two small
-- SQL helpers switch-profile needs (link validation + audit logging) — grouped here rather than
-- in a migration of their own since both are foundational to this table's whole purpose.
--
-- Not yet applied live — run this against the project before deploying the Edge Functions in
-- 163/164/165, which all assume this table exists.

create table linked_profiles (
  secondary_id uuid primary key references auth.users(id) on delete cascade,
  main_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id), -- admin who created it
  check (secondary_id <> main_id)
);

create index linked_profiles_main_id_idx on linked_profiles (main_id);

alter table linked_profiles enable row level security;

-- Nobody reads this client-side except the owner checking their own linked list, and moderators
-- resolving identity for a ban/report. Never exposed to any *other* user — this table is the one
-- thing that must never leak (that's the entire point of a pseudonymous linked profile).
create policy "an account reads its own links" on linked_profiles
  for select using (auth.uid() = main_id or auth.uid() = secondary_id);
create policy "moderators read all links" on linked_profiles
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
-- No client insert/update/delete policy at all — only create-linked-profile's Edge Function
-- (via service_role) can write this table.

-- Cap: a main account may have at most N linked profiles, and a secondary can only ever link to
-- one main (secondary_id is the primary key, so that's already enforced above). N is a constant
-- here, not a config row, so it's a one-line change during the admin testing phase:
create or replace function enforce_linked_profile_cap()
returns trigger as $$
begin
  if (select count(*) from linked_profiles where main_id = new.main_id) >= 25 then
    -- 25 while this is admin-only/testing. Drop to 5 before public release — search for this
    -- comment when you do (see linked-profiles-admin-only-spec.md's "Before public release").
    raise exception 'Linked profile cap reached for this account.';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger linked_profile_cap_trigger
  before insert on linked_profiles
  for each row execute function enforce_linked_profile_cap();

-- ------------------------------------------------------------------------------------------
-- Switching support — two small helpers the switch-profile Edge Function needs from day one.
-- Both are called through a caller-scoped client (anon key + the caller's own Authorization
-- header, same pattern every paystack-* Edge Function already uses for auth.uid()-scoped RPCs),
-- never through the service-role client, so auth.uid() below is always the real switcher.
-- ------------------------------------------------------------------------------------------

-- True if the calling account is allowed to switch into target_id: caller is the main and
-- target is one of their secondaries, caller is a secondary and target is their main, or caller
-- and target are sibling secondaries under the same main.
create or replace function can_switch_to_linked_profile(target_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from linked_profiles where main_id = auth.uid() and secondary_id = target_id)
    or exists (select 1 from linked_profiles where secondary_id = auth.uid() and main_id = target_id)
    or exists (
      select 1 from linked_profiles a join linked_profiles b on a.main_id = b.main_id
      where a.secondary_id = auth.uid() and b.secondary_id = target_id
    );
$$;

revoke all on function can_switch_to_linked_profile(uuid) from public;
grant execute on function can_switch_to_linked_profile(uuid) to authenticated;

-- One append-only log entry per switch — this is the one place impersonation-shaped code exists
-- in the app, so it should leave a trail. Reuses admin_audit_log (migration 114) rather than a
-- new table; actor_id is the account switching (auth.uid(), resolved from the caller's own JWT,
-- same as every other use of record_admin_action), target_id is the profile switched into.
-- record_admin_action() itself is revoked from every client role — this is the one place a
-- non-admin action is allowed to reach it, via its own narrow, single-purpose wrapper.
create or replace function record_profile_switch(target_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform record_admin_action('profile_switch', 'profiles', target_id, null, null, null, null);
end;
$$;

revoke all on function record_profile_switch(uuid) from public;
grant execute on function record_profile_switch(uuid) to authenticated;
