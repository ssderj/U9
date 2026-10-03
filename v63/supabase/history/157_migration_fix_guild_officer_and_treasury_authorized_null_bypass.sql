-- ============================================================================================
-- Migration 157: is_guild_officer() / is_guild_treasury_authorized() — anon NULL bypass
-- ============================================================================================
-- Same class of bug as migration 156 (transfer_guild_ownership), one level down: two shared
-- helper functions return a bare comparison/subquery result that can be NULL instead of false
-- for a signed-out caller, and every caller does `if not helper(...) then raise exception`,
-- where `not NULL` is NULL and a plpgsql IF treats NULL as false -- silently skipping the raise.
--
-- 1. is_guild_officer(), non-founder-guild branch:
--      return v_guild.owner_id = auth.uid();
--    auth.uid() is NULL for a signed-out caller, so `owner_id = NULL` is NULL, not false.
--    Reachable by anon (no grant change needed -- anon never had EXECUTE on this function
--    directly) via six anon-executable wrapper functions that gate through it:
--    cancel_guild_event, guild_officer_gate (-> create_guild_event_draft both overloads,
--    update_guild_event_draft both overloads), pay_guild_event_escrow_contributors,
--    propose_guild_event_objective_config.
--
-- 2. is_guild_treasury_authorized(), via guild_treasury_role()'s fallback branch:
--      else (select m.role from player_guild_members m where ... and m.user_id = p_user_id)
--    returns NULL (no matching row) rather than a value outside the authorized set, and
--    `NULL in ('leader','treasurer','officer')` is NULL, not false. Reachable by anon via
--    deposit_guild_event_prize_escrow -- the most serious of the six, since it debits real
--    guild treasury balance into escrow.
--
-- Fix, root cause only, nothing else touched:
--   - is_guild_officer(): require auth.uid() is not null before ever comparing it to owner_id.
--   - is_guild_treasury_authorized(): coalesce the IN-check to false so a NULL role (no match)
--     can never read as "not not-authorized". guild_treasury_role() itself is left as-is since
--     is_guild_treasury_authorized() is its only caller in this codebase (verified via a full
--     schema.sql caller search) -- fixing the boolean coercion at its one call site is the
--     more targeted change.
--
-- No grants touched: neither function has ever had anon EXECUTE directly (confirmed via
-- information_schema.role_routine_grants before this migration) -- only authenticated,
-- postgres, service_role, unchanged by this migration. The six downstream wrapper functions'
-- grants are also untouched; this migration is a pure logic fix. is_guild_member() was audited
-- alongside these two and found NOT to have the same flaw (it wraps its auth.uid() comparison in
-- EXISTS(...), which correctly returns false rather than NULL when there's no matching row).
--
-- Applied live 2026-09-26. Verified in a rolled-back transaction against a synthetic guild:
-- is_guild_officer(...) and is_guild_treasury_authorized(...) now return false (not NULL) for a
-- simulated signed-out caller; cancel_guild_event and deposit_guild_event_prize_escrow, called
-- end-to-end as that signed-out caller, now correctly raise "Only the guild owner can cancel
-- this event." / "Only the guild leader, treasurer, or an officer can authorize a treasury
-- spend." instead of proceeding. Regression checks: an authenticated non-owner/non-officer is
-- still correctly rejected (unchanged -- that path never depended on the NULL bug); the real
-- guild owner still passes is_guild_officer and can still cancel the event; a real treasury
-- officer still passes is_guild_treasury_authorized. Post-migration security advisor re-scan:
-- unchanged from migration 156's post-scan (this migration touches no grant, so the
-- grant-focused linter has nothing new to flag -- the bug it fixes is a logic/NULL-semantics
-- issue).
-- ============================================================================================

create or replace function is_guild_officer(p_guild_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    return false;
  end if;
  if v_guild.is_founder_guild then
    return is_inkroot_admin() and auth.uid() is not null;
  end if;
  -- NULL-safe (migration 157): a signed-out caller (auth.uid() is null) must never read as
  -- "officer" -- `v_guild.owner_id = auth.uid()` alone would be NULL, not false, for such a
  -- caller, and every caller of this function does `if not is_guild_officer(...) then raise`,
  -- where NULL is treated as false and silently skips the raise.
  return auth.uid() is not null and v_guild.owner_id = auth.uid();
end;
$$;

create or replace function is_guild_treasury_authorized(p_guild_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- NULL-safe (migration 157): guild_treasury_role() returns NULL (not a non-authorized
  -- sentinel) when p_user_id has no role in this guild -- including when p_user_id is NULL for
  -- a signed-out caller -- and `NULL in (...)` is NULL, not false. coalesce forces the
  -- no-role/no-caller case to false so `if not is_guild_treasury_authorized(...) then raise`
  -- always raises when it should.
  select coalesce(guild_treasury_role(p_guild_id, p_user_id) in ('leader', 'treasurer', 'officer'), false);
$$;
