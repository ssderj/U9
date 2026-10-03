-- ============================================================================================
-- Migration 146 — a late charge.success can no longer push an event over its participant_limit
-- (fix plan item L4, audit finding #17). OPTIONAL / post-launch.
--
-- The gap: create_guild_event_entry_locked() only counts an entry toward participant_limit while
-- it's 'success', or 'pending' AND younger than 30 minutes. A pending row older than that no
-- longer holds a slot, so the slot can be handed to someone else. But paystack-webhook flipped
-- ANY 'pending' row to 'success' on charge.success, however old — so an entrant who paid after
-- their 30-minute window (slow bank transfer, popup left open) could land as one entrant OVER the
-- limit, with nothing to tell anyone.
--
-- The fix: the webhook now calls apply_guild_event_entry_payment() instead of updating the row
-- itself. Under the SAME advisory lock create_guild_event_entry_locked()/settle_guild_event() use
-- for the event, it:
--   * pending and still inside its 30-minute hold          -> success (it always held its slot)
--   * pending, hold expired, event has room                 -> success (takes a slot, as before)
--   * pending, hold expired, event already at its limit     -> the row becomes 'failed' (no slot,
--                                                              nothing counts toward the pool) and
--                                                              'over_limit' is returned; the webhook
--                                                              alerts ops (EVENT_ENTRY_OVER_LIMIT) so
--                                                              the money is refunded by hand.
--   * already 'success'                                     -> 'already_applied' (a retried delivery)
--   * anything else (unknown reference, 'failed')           -> 'not_pending' / 'unmatched'; the
--                                                              webhook's existing unmatched-success
--                                                              alert still covers these.
-- Events with no participant_limit behave exactly as before (always success).
--
-- Deploy order: this migration first, THEN paystack-webhook. Additive: one new function, no
-- table or existing-function changes. Never edit this file once applied.
-- ============================================================================================

create or replace function apply_guild_event_entry_payment(p_reference text, p_paid_at timestamptz default now())
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_entry guild_event_entries%rowtype;
  v_limit integer;
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  select event_id into v_event_id from guild_event_entries where paystack_reference = p_reference;
  if not found then
    return 'unmatched';
  end if;

  -- Same lock key as create_guild_event_entry_locked() / settle_guild_event(): a late payment can't
  -- slip in between another entrant's limit check and their insert, or land mid-settlement.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || v_event_id::text));

  select * into v_entry from guild_event_entries where paystack_reference = p_reference for update;
  if v_entry.status = 'success' then
    return 'already_applied';
  end if;
  if v_entry.status <> 'pending' then
    return 'not_pending';
  end if;

  select participant_limit into v_limit from guild_events where id = v_entry.event_id;

  -- Only an EXPIRED hold needs the limit re-checked: a pending row younger than 30 minutes is still
  -- being counted by create_guild_event_entry_locked(), so it always has its slot.
  if v_limit is not null and v_entry.created_at <= now() - interval '30 minutes' then
    select count(*) into v_count from guild_event_entries
    where event_id = v_entry.event_id
      and id <> v_entry.id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_limit then
      update guild_event_entries set status = 'failed' where id = v_entry.id;
      return 'over_limit';
    end if;
  end if;

  update guild_event_entries set status = 'success', paid_at = p_paid_at where id = v_entry.id;
  return 'success';
end;
$$;

revoke all on function apply_guild_event_entry_payment(text, timestamptz) from public;
revoke all on function apply_guild_event_entry_payment(text, timestamptz) from anon, authenticated;
