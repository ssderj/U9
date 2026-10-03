-- Migration 148: platform_admin revocation refuses to drop the platform below 2 admins
-- (adversarial audit finding #2, floor option — chosen over two-person approval or a
-- cooldown+alert, since there is no dual-control infrastructure or alerting webhook to build on
-- yet, and the app currently has zero provisioned admins).
--
-- The gap: any single is_inkroot_admin() account can call admin_revoke_platform_role() to strip
-- ANY other admin's is_platform_admin — the only thing blocked is revoking your own role. There
-- is no admin_grant_platform_role() in-app (by design, to stop self-escalation), so one admin
-- revoking every other admin in sequence becomes the sole platform admin with no in-app recovery
-- path for the others.
--
-- The fix: extend admin_revoke_platform_role() (already touched by migration 147, whose treasurer-
-- flag change carries forward unchanged below) so that revoking 'platform_admin' first checks how
-- many accounts currently hold is_platform_admin. If that count is already at or below 2, the
-- revocation is refused — the platform can go from N admins down to 2, never to 1 or 0 through
-- this function. Revoking 'moderator' is unaffected: moderator is not the escalation path this
-- finding is about, and there's no equivalent single-admin power-grab risk for it.
--
-- Deliberately partial, matching the audit's own framing of this option: this stops an admin
-- picking off every other admin down to the floor, but does not stop them picking off admins one
-- at a time down to exactly 2, nor does it add any way to recover if the platform is ever
-- legitimately down to 1 or 0 admins already (only direct database access restores a role, same
-- as before this migration). Two-person approval (option 1 in the audit) or a cooldown+alert
-- (option 2) would close the remaining gap and can be layered on top of this later without
-- touching the floor check itself.
--
-- Operational note: at the time this migration was written, profiles.is_platform_admin is true
-- for zero accounts. The floor only engages once you're down to exactly 2 or fewer, so it has no
-- effect until at least 2 admins are actually provisioned — nothing to adjust here as admins are
-- onboarded.

create or replace function admin_revoke_platform_role(target_user_id uuid, role text, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
  v_new jsonb;
  v_admin_count integer;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can revoke a platform role.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Cannot revoke your own role.';
  end if;
  if role not in ('moderator', 'platform_admin') then
    raise exception 'Unknown role.';
  end if;

  if role = 'platform_admin' then
    select count(*) into v_admin_count from profiles where is_platform_admin;
    if v_admin_count <= 2 then
      raise exception 'Cannot revoke platform_admin — the platform must keep at least 2 admins.';
    end if;
  end if;

  select jsonb_build_object(
    'is_moderator', is_moderator,
    'is_platform_admin', is_platform_admin,
    'is_founder_guild_treasurer', is_founder_guild_treasurer
  )
  into v_prev from profiles where id = target_user_id;

  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  if role = 'moderator' then
    update profiles set is_moderator = false where id = target_user_id;
  else
    update profiles set is_platform_admin = false, is_founder_guild_treasurer = false where id = target_user_id;
  end if;

  insert into admin_role_revocations (target_user_id, revoked_by, role, reason)
  values (target_user_id, auth.uid(), role, nullif(trim(coalesce(reason, '')), ''));

  select jsonb_build_object(
    'is_moderator', is_moderator,
    'is_platform_admin', is_platform_admin,
    'is_founder_guild_treasurer', is_founder_guild_treasurer
  )
  into v_new from profiles where id = target_user_id;
  perform record_admin_action('revoke_platform_role', 'profiles', target_user_id, v_prev, v_new, null, reason);
end;
$$;
