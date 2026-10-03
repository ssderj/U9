-- ============================================================================================
-- Migration 165: cascade bans to linked profiles
-- ============================================================================================
-- Two ban mechanisms exist today (content ban vs. login ban) — this cascades both, in the two
-- places that already own each. A linked profile's whole purpose is pseudonymity for one real
-- person; a ban that only reaches one of their two accounts is not a ban.

-- ------------------------------------------------------------------------------------------
-- Login ban — admin_set_login_ban(), redefined: existing body unchanged, plus a cascade step
-- at the end that repeats the same banned_until / session-clear / login_banned update for every
-- account linked to target_user_id (in either direction — a banned main cascades to every
-- secondary, a banned secondary cascades to its one main).
-- ------------------------------------------------------------------------------------------
create or replace function admin_set_login_ban(target_user_id uuid, should_ban boolean, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
  v_linked_id uuid;
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_moderator) then
    raise exception 'Only a moderator can change login-ban status.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Cannot change your own login-ban status.';
  end if;

  -- Migration 114: snapshot the mirror columns before anything is changed, for the audit log.
  select jsonb_build_object('login_banned', login_banned, 'login_ban_reason', login_ban_reason)
  into v_prev from profiles where id = target_user_id;

  update auth.users set banned_until = case when should_ban then 'infinity'::timestamptz else null end
  where id = target_user_id;

  if should_ban then
    -- Same technique, and the same residual-token caveat, as purge_expired_account_deletions
    -- further below: this blocks all FUTURE sign-ins and token refreshes immediately, but an
    -- access token already issued before this call keeps working until it naturally expires
    -- (your project's JWT expiry window — Auth settings, default 1 hour). Deleting the
    -- session/refresh token here still matters: without it, the ban would only stop a brand-new
    -- sign-in, not someone who's already signed in and would otherwise just keep refreshing
    -- forever on their existing session.
    delete from auth.sessions where user_id = target_user_id;
    delete from auth.refresh_tokens where user_id = target_user_id::text;
  end if;

  -- Updates the client-readable mirror via the narrow trusted-RPC bypass in
  -- protect_admin_profile_columns above — see that trigger's comment on login_banned. is_local
  -- (the third argument) means this setting is automatically cleared at the end of this
  -- transaction, so it can never leak into any later, unrelated statement.
  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  update profiles set login_banned = should_ban, login_ban_reason = case when should_ban then reason else null end
  where id = target_user_id;

  -- Migration 114: only logged when the target profile exists (v_prev is null otherwise, and
  -- the update above changed nothing worth recording).
  if v_prev is not null then
    perform record_admin_action(
      case when should_ban then 'login_ban_set' else 'login_ban_cleared' end,
      'profiles', target_user_id, v_prev,
      jsonb_build_object('login_banned', should_ban, 'login_ban_reason', case when should_ban then reason else null end),
      null, reason);
  end if;

  -- Migration 165: cascade to every account linked to target_user_id, in either direction.
  -- Repeats the exact same block above for each linked id found — deliberately NOT a recursive
  -- call to this function, since a linked profile's whole roster (main + every secondary) should
  -- all end up banned from one call, not chain into further self-checks.
  for v_linked_id in
    select secondary_id from linked_profiles where main_id = target_user_id
    union
    select main_id from linked_profiles where secondary_id = target_user_id
  loop
    select jsonb_build_object('login_banned', login_banned, 'login_ban_reason', login_ban_reason)
    into v_prev from profiles where id = v_linked_id;

    update auth.users set banned_until = case when should_ban then 'infinity'::timestamptz else null end
    where id = v_linked_id;

    if should_ban then
      delete from auth.sessions where user_id = v_linked_id;
      delete from auth.refresh_tokens where user_id = v_linked_id::text;
    end if;

    perform set_config('inkroot.trusted_admin_rpc', 'true', true);
    update profiles set login_banned = should_ban, login_ban_reason = case when should_ban then reason else null end
    where id = v_linked_id;

    if v_prev is not null then
      perform record_admin_action(
        case when should_ban then 'login_ban_set' else 'login_ban_cleared' end,
        'profiles', v_linked_id, v_prev,
        jsonb_build_object('login_banned', should_ban, 'login_ban_reason', case when should_ban then reason else null end),
        null, coalesce(reason, '') || ' (cascaded from linked account)');
    end if;
  end loop;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- Content ban — banAccount/unbanAccount in src/lib/moderation.js do a raw client
-- `UPDATE profiles SET banned = ...`, permitted by the protect_admin_profile_columns trigger.
-- This is additive: a NEW, separate AFTER UPDATE OF banned trigger cascades it, without touching
-- protect_admin_profile_columns itself — migrations 27/28/30/43's logic is untouched.
-- ------------------------------------------------------------------------------------------
create or replace function cascade_content_ban_to_linked_profiles()
returns trigger as $$
declare
  v_linked_id uuid;
begin
  if new.banned is distinct from old.banned then
    for v_linked_id in
      select secondary_id from linked_profiles where main_id = new.id
      union
      select main_id from linked_profiles where secondary_id = new.id
    loop
      -- Same bypass admin_set_login_ban already uses to write through
      -- protect_admin_profile_columns — is_local so it can't leak into any later statement.
      perform set_config('inkroot.trusted_admin_rpc', 'true', true);
      update profiles set banned = new.banned, ban_reason = new.ban_reason
      where id = v_linked_id and banned is distinct from new.banned;
    end loop;
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger cascade_content_ban_trigger
  after update of banned on profiles
  for each row execute function cascade_content_ban_to_linked_profiles();
