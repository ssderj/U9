-- Migration 147: revoking platform_admin no longer leaves Founder Guild treasury authority behind
-- (adversarial audit finding #1).
--
-- The gap: guild_treasury_role() grants 'leader' on the Founder Guild purely on
-- profiles.is_founder_guild_treasurer, a flag set only via direct SQL and explicitly documented
-- as independent of is_platform_admin. admin_revoke_platform_role() only ever flipped
-- is_moderator / is_platform_admin — it never touched this flag, so revoking someone's admin
-- role left their Founder Guild treasury authority fully intact.
--
-- The fix: extend admin_revoke_platform_role() so that revoking 'platform_admin' also sets
-- is_founder_guild_treasurer = false in the same transaction, and folds that flag into the
-- previous_state/new_state jsonb already written to admin_audit_log via record_admin_action(),
-- so the audit trail shows exactly what changed. Revoking 'moderator' is unaffected — the
-- treasurer flag has nothing to do with moderation. Same signature, same guards (only an
-- Inkroot admin can call it, cannot revoke your own role, same admin_role_revocations insert)
-- as the version this replaces.
--
-- Not retroactive in any dangerous sense: this only changes behavior going forward, the next
-- time admin_revoke_platform_role(..., 'platform_admin', ...) is called. It does not touch any
-- row for someone whose admin role was already revoked before this migration ran — if that
-- matters for an existing account, clear is_founder_guild_treasurer for them by hand.

create or replace function admin_revoke_platform_role(target_user_id uuid, role text, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
  v_new jsonb;
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
    -- Revoking platform_admin also closes the Founder Guild treasury back door: without this,
    -- a former admin who was ever granted is_founder_guild_treasurer keeps authorizing spends
    -- from the Founder Guild treasury indefinitely.
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
