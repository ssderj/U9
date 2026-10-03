-- Migration 151: guild ownership transfer path + a hard account-deletion gate for sole treasury
-- owners (adversarial audit finding #5, options 1 + 3 — the recommended pairing; option 2, the
-- admin last-resort override, is deliberately not included here).
--
-- The gap as described in the audit: set_guild_treasury_role() can only be called by the current
-- owner, and nothing in the schema can ever change player_guilds.owner_id. If a sole owner never
-- appointed a treasurer/officer and then deletes their account, every treasury-spend RPC becomes
-- permanently uncallable for that guild — balance intact, unspendable.
--
-- ONE CORRECTION TO THE AUDIT'S OWN FRAMING, found while building this fix: it is not quite true
-- that "nothing... can ever change owner_id." The "owner updates their guild" RLS policy on
-- player_guilds (`using (auth.uid() = owner_id)`) has no `with_check` and there is no trigger on
-- this table at all — so today, the current owner can already run a plain client
-- `.update({ owner_id: anyone })` and hand the guild to literally anyone, member or not,
-- completely unvalidated and unaudited. That's a real gap in its own right (worse than "no path,"
-- since an uncontrolled one already exists) and this migration closes it as part of adding the
-- real transfer path.
--
-- The fix, in three parts:
--   1. transfer_guild_ownership(p_guild_id, p_new_owner_id) — the one legitimate way to change
--      owner_id from here on. Callable only by the current owner, requires the new owner to
--      already be a member in good standing (not banned, not the Founder Guild — it has no
--      single owner), moves owner_id, drops the new owner's now-redundant player_guild_members
--      row (owner_id is how leadership is tracked, same as before), seats the outgoing owner as
--      an ordinary member rather than ejecting them, and logs the change to a new
--      guild_ownership_transfers table (kept separate from admin_audit_log/record_admin_action,
--      which are for admin/moderator actions — this is a routine owner self-service action, not
--      an admin one).
--   2. A new BEFORE UPDATE trigger on player_guilds rejects any direct change to owner_id unless
--      transfer_guild_ownership() set a transaction-local flag first — the same narrow,
--      is_local = true set_config pattern already used for admin_revoke_platform_role and (as of
--      migration 150) moderator_set_content_removed. The existing "owner updates their guild" RLS
--      policy is left in place for every other column (name, motto, crest_url, invite_code).
--   3. check_account_deletion_guild_impact() (migration 79, redefined in place — see its original
--      comment above for why the softer acknowledgment-only version was chosen at the time) gains
--      a hard block, checked before the existing acknowledgment check: a sole owner with no other
--      player_guild_members row holding 'treasurer' or 'officer' cannot delete their account at
--      all, full stop, until they either appoint one (set_guild_treasury_role) or hand off
--      ownership (transfer_guild_ownership). If every guild they own already has a delegated
--      treasury role, the existing softer acknowledgment flow is unchanged.
--
-- Not retroactive: no existing player_guilds row or account_deletions row is touched. A guild
-- that's already a sole-owner-with-no-delegate today is simply unable to have its owner delete
-- their account starting now, same as any newly created one.

create table if not exists guild_ownership_transfers (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  previous_owner_id uuid not null references auth.users(id),
  new_owner_id uuid not null references auth.users(id),
  transferred_at timestamptz not null default now()
);

alter table guild_ownership_transfers enable row level security;

create policy "parties and guild members can read ownership transfers"
  on guild_ownership_transfers for select
  using (
    auth.uid() = previous_owner_id
    or auth.uid() = new_owner_id
    or is_guild_member(guild_id)
    or is_inkroot_admin()
  );

create or replace function protect_guild_ownership_from_direct_edit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.owner_id is distinct from old.owner_id
     and coalesce(current_setting('inkroot.trusted_guild_ownership_rpc', true), '') <> 'true' then
    raise exception 'Guild ownership can only be changed via transfer_guild_ownership().';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_guild_ownership_from_direct_edit_trigger on player_guilds;
create trigger protect_guild_ownership_from_direct_edit_trigger
  before update on player_guilds
  for each row execute function protect_guild_ownership_from_direct_edit();

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
  if auth.uid() <> v_guild.owner_id then
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

  -- Leadership is tracked via player_guilds.owner_id, same as every guild — drop the new owner's
  -- now-redundant player_guild_members row. Seat the outgoing owner as an ordinary member rather
  -- than ejecting them from the guild they founded.
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

revoke all on function transfer_guild_ownership(uuid, uuid) from public;
grant execute on function transfer_guild_ownership(uuid, uuid) to authenticated;

-- check_account_deletion_guild_impact() — redefined in place (same trigger, same table).
create or replace function check_account_deletion_guild_impact()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_guild record;
begin
  if new.status = 'pending' then
    -- Hard block: a sole owner with nobody else authorized to spend from the treasury cannot
    -- delete their account at all — appoint a treasurer/officer or transfer ownership first.
    for v_guild in
      select g.id from player_guilds g
      where g.owner_id = new.user_id and not g.is_founder_guild
    loop
      if not exists (
        select 1 from player_guild_members m
        where m.guild_id = v_guild.id and m.role in ('treasurer', 'officer')
      ) then
        raise exception 'ACCOUNT_DELETION_BLOCKED_SOLE_TREASURY_OWNER';
      end if;
    end loop;

    -- Softer, acknowledgment-satisfiable case: every owned guild already has a delegate, but the
    -- owner still hasn't confirmed they understand the impact of leaving.
    if not new.acknowledges_owned_guild_impact
       and exists (
         select 1 from player_guilds g
         where g.owner_id = new.user_id and not g.is_founder_guild
       )
    then
      raise exception 'ACCOUNT_DELETION_BLOCKED_OWNS_PLAYER_GUILD';
    end if;
  end if;
  return new;
end;
$$;
