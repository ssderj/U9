-- Migration 186: track refunds owed when a paid event is cancelled.
--
-- WHY: cancelling an event returns the PRIZE escrow (migrations 108/113/131/132), but a paid entrant's
-- entry fee is never moved by the app -- Inkroot has never called Paystack's refund API. Refunds are sent
-- by hand from Paystack's dashboard. Until now nothing recorded WHO was owed, so a cancelled paid event
-- could leave entrants unrefunded with no list to work from. This migration only TRACKS the debt. It moves
-- no money and adds no payment system.
--
-- WHICH CANCEL PATHS: cancel_guild_event() refuses any event with a paid entrant, so in practice only
-- admin_cancel_guild_event_dispute() (guild events AND official events -- the official admin screen calls
-- the same function) ever cancels an event that has paid entries. Rather than redefine both large
-- functions, a trigger on guild_events fires whenever status becomes 'cancelled', so every path -- present
-- and future -- is covered by one small piece of code and neither cancel function changes.
--
-- WHAT COUNTS AS OWED:
--   * status = 'success' and amount_kobo > 0. Free official entries (amount_kobo = 0, migration 185)
--     paid nothing, so nothing is owed. Giveaway tickets are free too and are not entries.
--   * the amount owed is amount_kobo (what the entrant actually paid), NOT net_kobo (after the platform
--     fee): the entrant's bank statement shows the full charge.
--   * 'pending' entries are not owed yet. If one succeeds late (the Paystack webhook can land after the
--     cancel), the second trigger below marks it owed at that moment -- money that arrives after a cancel
--     is exactly the case that would otherwise be missed. Migration 146 covers the related entry-limit race.
--
-- HOW AN ENTRY LEAVES THE LIST: (a) an admin marks it refunded after sending the money on Paystack, or
-- (b) Paystack's refund.processed webhook flips the entry's status to 'refunded' (migration 50) -- the list
-- treats that as already refunded, so a refund processed through Paystack clears itself.

-- 1. Columns ---------------------------------------------------------------------------------------
alter table guild_event_entries
  add column if not exists refund_owed_at timestamptz,
  add column if not exists refunded_at timestamptz,
  -- set null (not cascade): deleting an admin's account must not delete or block a financial record.
  add column if not exists refunded_by uuid references auth.users(id) on delete set null,
  add column if not exists refund_note text;

alter table guild_event_entries drop constraint if exists guild_event_entries_refund_note_len;
alter table guild_event_entries add constraint guild_event_entries_refund_note_len
  check (refund_note is null or length(refund_note) <= 500);

create index if not exists guild_event_entries_refund_owed_idx
  on guild_event_entries (refund_owed_at)
  where refund_owed_at is not null and refunded_at is null;

-- 2. A cancelled event marks its paid entries as owed ------------------------------------------------
create or replace function mark_entries_refund_owed_on_cancel()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update guild_event_entries
    set refund_owed_at = coalesce(new.cancelled_at, now())
    where event_id = new.id
      and status = 'success'
      and amount_kobo > 0
      and refund_owed_at is null;   -- idempotent: a re-run never moves the date
  end if;
  return new;
end;
$$;
revoke all on function mark_entries_refund_owed_on_cancel() from public, anon, authenticated;

drop trigger if exists guild_events_mark_refunds_owed on guild_events;
create trigger guild_events_mark_refunds_owed
  after update of status on guild_events
  for each row execute function mark_entries_refund_owed_on_cancel();

-- 3. An entry that turns 'success' AFTER its event was cancelled is owed too --------------------------
create or replace function mark_late_entry_refund_owed()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'success' and old.status is distinct from 'success'
     and new.amount_kobo > 0 and new.refund_owed_at is null
     and exists (select 1 from guild_events e where e.id = new.event_id and e.status = 'cancelled') then
    new.refund_owed_at := now();
  end if;
  return new;
end;
$$;
revoke all on function mark_late_entry_refund_owed() from public, anon, authenticated;

drop trigger if exists guild_event_entries_late_refund_owed on guild_event_entries;
create trigger guild_event_entries_late_refund_owed
  before update of status on guild_event_entries
  for each row execute function mark_late_entry_refund_owed();

-- 4. Backfill: events already cancelled before this migration ----------------------------------------
update guild_event_entries en
set refund_owed_at = coalesce(e.cancelled_at, now())
from guild_events e
where e.id = en.event_id
  and e.status = 'cancelled'
  and en.status = 'success'
  and en.amount_kobo > 0
  and en.refund_owed_at is null;

-- 5. Admin list ---------------------------------------------------------------------------------------
-- Owed = marked owed, not marked refunded, and not already flipped to 'refunded' by Paystack's webhook.
create or replace function admin_list_refunds_owed()
returns table (
  entry_id uuid,
  event_id uuid,
  event_title text,
  is_official boolean,
  entrant_id uuid,
  entrant_name text,
  amount_kobo bigint,
  paystack_reference text,
  owed_at timestamptz,
  cancellation_reason text
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can see refunds owed.';
  end if;
  return query
    select en.id, e.id, e.title, (e.host = 'inkroot'), en.entrant_id,
           guild_tournament_display_name(en.entrant_id), en.amount_kobo, en.paystack_reference,
           en.refund_owed_at, e.cancellation_reason
    from guild_event_entries en
    join guild_events e on e.id = en.event_id
    where en.refund_owed_at is not null
      and en.refunded_at is null
      and en.status = 'success'
    order by en.refund_owed_at asc, en.id asc;
end;
$$;
revoke all on function admin_list_refunds_owed() from public, anon;
grant execute on function admin_list_refunds_owed() to authenticated;

-- 6. Mark one refunded --------------------------------------------------------------------------------
-- Idempotent: marking an entry that is already marked is a safe no-op that returns the existing date.
-- The optional note is for the Paystack refund reference or anything the admin wants on the record.
create or replace function admin_mark_entry_refunded(p_entry_id uuid, p_note text default null)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_entry guild_event_entries%rowtype;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can mark a refund as sent.';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'Keep the note under 500 characters.';
  end if;

  select * into v_entry from guild_event_entries where id = p_entry_id for update;
  if not found then
    raise exception 'Entry not found.';
  end if;
  if v_entry.refund_owed_at is null then
    raise exception 'No refund is owed on this entry.';
  end if;
  if v_entry.refunded_at is not null then
    return v_entry.refunded_at;
  end if;

  update guild_event_entries
  set refunded_at = now(), refunded_by = auth.uid(), refund_note = v_note
  where id = p_entry_id
  returning refunded_at into v_entry.refunded_at;

  perform record_admin_action(
    'mark_event_entry_refunded', 'guild_event_entries', p_entry_id,
    jsonb_build_object('refund_owed_at', v_entry.refund_owed_at, 'refunded_at', null),
    jsonb_build_object('refunded_at', v_entry.refunded_at),
    v_entry.amount_kobo, v_note);
  return v_entry.refunded_at;
end;
$$;
revoke all on function admin_mark_entry_refunded(uuid, text) from public, anon;
grant execute on function admin_mark_entry_refunded(uuid, text) to authenticated;
