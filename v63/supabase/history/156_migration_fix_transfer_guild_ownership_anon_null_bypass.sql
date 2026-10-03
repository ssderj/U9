-- ============================================================================================
-- Migration 156: transfer_guild_ownership — anon NULL-comparison bypass (critical)
-- ============================================================================================
-- Two independent problems, both fixed here, nothing else touched:
--
-- 1. anon had EXECUTE on this SECURITY DEFINER function (a Supabase default-privilege grant,
--    never explicitly intended -- same class of gap migration 143's
--    revoke_client_execute_refund_escrow_contributors and 153's
--    default_privileges_no_anon_execute already closed for other functions, just not this one).
--
-- 2. The ownership check itself, `if auth.uid() <> v_guild.owner_id then raise exception ...`,
--    is not NULL-safe. For a caller with no JWT at all, auth.uid() is NULL, and
--    `NULL <> anything` evaluates to NULL -- which a PL/pgSQL `IF` treats as false, so the
--    branch is silently skipped. Combined with (1), any unauthenticated request could call
--    transfer_guild_ownership(guild_id, new_owner_id) and, provided new_owner_id was already a
--    member of that guild and not banned, actually transfer that guild's ownership -- a full
--    account-independent guild takeover, with no sign-in required.
--
-- Fix: revoke anon's EXECUTE, and rewrite the check to explicitly reject a NULL auth.uid()
-- before ever comparing it to owner_id, so the function is safe on its own even independent of
-- grants. Every other check in the function (founder-guild guard, already-the-owner guard,
-- banned-user guard, must-already-be-a-member guard) and every other function's grants are
-- untouched.
--
-- Applied live 2026-09-26 as migration 156_fix_transfer_guild_ownership_anon_null_bypass.
-- Verified: anon EXECUTE revoked (has_function_privilege confirms false); authenticated/
-- postgres/service_role unchanged; signed-out caller now rejected by the function itself
-- (not just by the grant); authenticated non-owner still rejected; the real owner can still
-- transfer to a valid, non-banned, existing member; banned-user and membership guards still
-- fire. All tests run in a rolled-back transaction against synthetic fixtures -- no production
-- data touched. Security advisor re-scan post-migration: anon_security_definer_function_
-- executable count dropped from 37 to 36 (exactly this function, nothing else); every other
-- finding (function_search_path_mutable: 12, authenticated_security_definer_function_
-- executable: 107, rls_enabled_no_policy: 4) unchanged.
-- ============================================================================================

revoke execute on function transfer_guild_ownership(uuid, uuid) from anon;

create or replace function transfer_guild_ownership(p_guild_id uuid, p_new_owner_id uuid)
returns player_guilds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
  v_old_owner uuid;
begin
  select * into v_guild from player_guilds where id = p_guild_id for update;
  if not found then
    raise exception 'Guild not found.';
  end if;
  if v_guild.is_founder_guild then
    raise exception 'The Founder Guild has no single leader to transfer.';
  end if;
  -- NULL-safe: a signed-out caller (auth.uid() is null) is rejected outright, before ever being
  -- compared to owner_id -- `auth.uid() <> v_guild.owner_id` alone would evaluate to NULL (not
  -- true) for such a caller, which a plpgsql IF treats as false and silently skips.
  if auth.uid() is null or auth.uid() <> v_guild.owner_id then
    raise exception 'Only the current guild leader can transfer ownership.';
  end if;
  if p_new_owner_id = v_guild.owner_id then
    raise exception 'That writer already leads this guild.';
  end if;
  if is_banned(p_new_owner_id) then
    raise exception 'A suspended account cannot lead a guild.';
  end if;
  if not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = p_new_owner_id
  ) then
    raise exception 'The new leader must already be a member of this guild.';
  end if;

  v_old_owner := v_guild.owner_id;

  perform set_config('inkroot.trusted_guild_ownership_rpc', 'true', true);
  update player_guilds set owner_id = p_new_owner_id, updated_at = now() where id = p_guild_id;

  delete from player_guild_members where guild_id = p_guild_id and user_id = p_new_owner_id;
  insert into player_guild_members (guild_id, user_id)
    values (p_guild_id, v_old_owner)
    on conflict (guild_id, user_id) do nothing;

  insert into guild_ownership_transfers (guild_id, previous_owner_id, new_owner_id)
  values (p_guild_id, v_old_owner, p_new_owner_id);

  select * into v_guild from player_guilds where id = p_guild_id;
  return v_guild;
end;
$$;
