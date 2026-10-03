-- ============================================================================================
-- Migration 163: gate linked profiles out of Player Guild functions
-- ============================================================================================
-- The one restriction linked-profiles-admin-only-spec.md places on a linked (secondary) profile:
-- it can't join or found a Player Guild, and can't enter a cash-prize Guild Event. Everything
-- else — publishing, Living Universe, follows, reviews, achievements, Founder Guild — stays open,
-- so only these three functions are touched. Redefines each with its existing body unchanged
-- plus one new check; no other logic, no signature change, same grants.
--
-- is_linked_profile(check_user_id) below is the one helper all three call, so there's exactly one
-- place that defines "is this account a linked secondary" — reused again by 164 and 165.
create or replace function is_linked_profile(check_user_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from linked_profiles where secondary_id = check_user_id);
$$;

-- ------------------------------------------------------------------------------------------
-- 1. join_player_guild_by_code — runs as `authenticated`, auth.uid() is the real caller, so the
--    gate reads exactly as spec'd: is_linked_profile(auth.uid()).
-- ------------------------------------------------------------------------------------------
create or replace function join_player_guild_by_code(p_code text)
returns table (id uuid, name text, motto text, crest_url text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t join a guild.';
  end if;

  if is_linked_profile(auth.uid()) then
    raise exception 'Linked profiles can''t join a Player Guild.';
  end if;

  -- Migration 137: same lock key create_or_get_own_guild() above takes — see its comment.
  -- Taken before either "not seated elsewhere" check below, and before the rate-limited
  -- lookup, so a caller who loses the race pays no rate-limit cost for a guess that was
  -- always going to be refused once it re-checks (matches the existing reasoning for why
  -- the rate limit itself sits after this check, not before it).
  perform pg_advisory_xact_lock(hashtext('guild_membership:' || auth.uid()::text));

  -- Migration 126: same "one guild at a time" backstop as create_or_get_own_guild() above.
  -- Checked before the rate-limited lookup so a caller already seated elsewhere never spends an
  -- attempt guessing a code they'd be refused anyway.
  if exists (select 1 from player_guild_members m where m.user_id = auth.uid()) then
    raise exception 'You''re already seated in a guild — leave it before joining another.';
  end if;
  if exists (select 1 from founder_guild_members m where m.user_id = auth.uid()) then
    raise exception 'Leave your Founder Guild before joining a Player Guild.';
  end if;

  -- Counted BEFORE the lookup, and a miss below returns no rows instead of raising: a raised
  -- exception would roll back this function's own transaction, un-counting exactly the failed
  -- guesses the limit exists to catch.
  perform check_and_bump_rate_limit('join_guild');

  select * into v_guild from player_guilds g where g.invite_code = lower(p_code);
  if not found then
    return; -- no rows -> the client's .single() errors and shows "No guild found with that invite code."
  end if;

  insert into player_guild_members (guild_id, user_id)
  values (v_guild.id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select v_guild.id, v_guild.name, v_guild.motto, v_guild.crest_url, v_guild.owner_id;
end;
$$;

grant execute on function join_player_guild_by_code(text) to authenticated;

-- ------------------------------------------------------------------------------------------
-- 2. create_or_get_own_guild — same as above, auth.uid() is the real caller.
-- ------------------------------------------------------------------------------------------
create or replace function create_or_get_own_guild(p_id uuid, p_name text, p_motto text, p_crest_url text)
returns setof player_guilds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing player_guilds%rowtype;
begin
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t found or edit a guild.';
  end if;

  if is_linked_profile(auth.uid()) then
    raise exception 'Linked profiles can''t join a Player Guild.';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Give your guild a name.';
  end if;

  if char_length(trim(p_name)) > 60 then
    raise exception 'Guild name is too long (60 characters max).';
  end if;

  if is_reserved_guild_name(p_name) then
    raise exception 'That name isn''t available.';
  end if;

  -- A Founder Guild's id is a public constant (see FOUNDER_GUILDS in guild-hall.jsx), never a
  -- guild this RPC is allowed to touch — see this migration's header, point 5.
  if exists (select 1 from player_guilds where id = p_id and is_founder_guild) then
    raise exception 'That id is reserved.';
  end if;

  -- Migration 137: serializes against a concurrent call to this function, and against
  -- join_player_guild_by_code() below (same lock key), for this same caller — so two
  -- simultaneous attempts to seat this writer in two different guilds can't both pass the
  -- checks that follow before either insert commits. Taken before any of those checks read
  -- player_guild_members/founder_guild_members, and held for the rest of this transaction.
  perform pg_advisory_xact_lock(hashtext('guild_membership:' || auth.uid()::text));

  select * into v_existing from player_guilds where owner_id = auth.uid();
  -- Found is the giveaway of the bug this closes: a *different* locally-generated id (from a
  -- second device, or a cleared local profile) trying to found a second guild for the same
  -- owner. Same id just means "re-entering / editing my own guild" and always falls through to
  -- the upsert below, same as it always has.
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  -- Migration 140: a pending account-deletion request blocks FOUNDING (or re-entering, i.e.
  -- retrying a founding that never reached the server) a guild — the purge cron never re-checks
  -- guild ownership, so a guild founded inside the 30-day grace window would be orphaned on day
  -- 30 exactly the way migration 79's request-time check exists to prevent. Deliberately keyed
  -- on "caller owns no guild yet" (v_existing is null), NOT on the call as a whole: this same
  -- RPC is the upsert behind every edit of an existing guild (saveOwnGuild pushes every
  -- keystroke), and someone who already owns a guild and requested deletion (having acknowledged
  -- migration 79's warning) must keep being able to edit it. Cancelling the deletion (which
  -- deletes the account_deletions row — see cancelAccountDeletion in lib/account-deletion.js)
  -- lifts the block immediately; only status = 'pending' counts. The wording below is shown to
  -- the writer as-is (P0001 passes through sanitizeError, and guildSyncNotice in ink-root.jsx
  -- displays e.message), so it says what to do about it.
  if v_existing.id is null and exists (
    select 1 from account_deletions d where d.user_id = auth.uid() and d.status = 'pending'
  ) then
    raise exception 'You can''t found a guild while an account deletion is pending — cancel the deletion first, then try again.';
  end if;

  -- Migration 126: "one guild at a time" was previously only a client-side rule. A caller
  -- already seated in a *different* Player Guild (as owner or member — create_or_get_own_guild
  -- always inserts the owner into player_guild_members too, so this one check covers both) or
  -- in any Founder Guild must leave it before founding/re-entering this one.
  if exists (
    select 1 from player_guild_members m where m.user_id = auth.uid() and m.guild_id <> p_id
  ) then
    raise exception 'You''re already seated in a guild — leave it before founding a new one.';
  end if;
  if exists (select 1 from founder_guild_members m where m.user_id = auth.uid()) then
    raise exception 'Leave your Founder Guild before founding a Player Guild.';
  end if;

  -- An id that already exists under a different owner is never ours to write to.
  if exists (select 1 from player_guilds where id = p_id and owner_id <> auth.uid()) then
    raise exception 'You can only edit a guild you own.';
  end if;

  insert into player_guilds (id, name, motto, crest_url, owner_id, updated_at)
  values (p_id, trim(p_name), p_motto, p_crest_url, auth.uid(), now())
  on conflict (id) do update set
    name = excluded.name,
    motto = excluded.motto,
    crest_url = excluded.crest_url,
    updated_at = now()
  where player_guilds.owner_id = auth.uid();

  insert into player_guild_members (guild_id, user_id)
  values (p_id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select * from player_guilds where id = p_id;
end;
$$;

grant execute on function create_or_get_own_guild(uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------------------------------------
-- 3. create_guild_event_entry_locked — NOT the same shape as the two above. This function is
--    service_role-only (it hard-checks auth.role() = 'service_role' at its top); it's called
--    from the paystack-init-event-entry Edge Function using the SERVICE client, so auth.uid()
--    inside this function's body is always null — it is never the entrant. The entrant is the
--    p_user_id parameter the Edge Function passes in explicitly. Gating this function on
--    is_linked_profile(auth.uid()) — as an earlier draft of this spec had it — would silently
--    never fire, since auth.uid() is always null here. The gate has to read p_user_id instead.
-- ------------------------------------------------------------------------------------------
create or replace function create_guild_event_entry_locked(
  p_user_id uuid, p_event_id uuid, p_paystack_reference text, p_amount_kobo bigint, p_net_kobo bigint
)
returns guild_event_entries
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_entries%rowtype;
  v_row guild_event_entries;
  v_count integer;
  v_had_existing boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  if is_linked_profile(p_user_id) then
    raise exception 'Linked profiles can''t enter Guild Events.';
  end if;

  -- Same lock key settle_guild_event() uses for this event — an entry can't be created mid-
  -- settlement, and two simultaneous entry attempts for the same event now fully serialize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'This event has no entry fee to pay.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'This event is no longer taking entries.';
  end if;
  -- Migration 129: a hard stop independent of status/approval_status, which only get flipped by
  -- complete_guild_event() (manual) or close_ended_guild_events() (hourly cron) — neither of
  -- which is instantaneous with the clock ticking past end_date.
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This event''s entry period has ended.';
  end if;

  select * into v_existing from guild_event_entries
  where event_id = p_event_id and entrant_id = p_user_id;
  -- FOUND is reset by every later SELECT INTO (the participant-limit count below), so it is
  -- captured here instead of being re-read further down.
  v_had_existing := found;

  if v_had_existing and v_existing.status not in ('pending', 'failed') then
    raise exception 'You''ve already entered this event.';
  end if;

  -- Their own unfinished checkout: same slot, new reference. No limit check — they already hold it.
  if v_had_existing and v_existing.status = 'pending' then
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, created_at = now()
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  if v_had_existing then
    -- A previously failed attempt: re-open it rather than violating unique (event_id, entrant_id).
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, status = 'pending', created_at = now(), paid_at = null
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status)
  values (p_event_id, p_user_id, p_paystack_reference, p_amount_kobo, p_net_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_guild_event_entry_locked(uuid, uuid, text, bigint, bigint) from public;
