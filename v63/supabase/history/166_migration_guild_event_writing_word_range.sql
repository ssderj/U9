-- 166_migration_guild_event_writing_word_range.sql
--
-- Adds an optional minimum/maximum word count to writing-contest guild events (see the Guild
-- Events UI redesign spec, "Writing Events"). Entries outside the range are rejected both in the
-- client (guild-event-writing-panel.jsx) and here, server-side — the client check alone is just a
-- UX guard, easily bypassed by calling submit_guild_event_submission() directly, so this is the
-- check that actually matters.
--
-- Run this against an existing deployment that already ran 45_migration_guild_event_creation_workflow.sql
-- (event_type, create_guild_event_draft, update_guild_event_draft) and
-- 121_migration_guild_event_fair_judging.sql (submit_guild_event_submission's current shape). A
-- fresh install doesn't need this file — supabase/schema.sql already has it folded in.

-- ------------------------------------------------------------------------------------------------
-- 1. New columns on guild_events.
-- ------------------------------------------------------------------------------------------------

alter table guild_events
  add column if not exists min_word_count integer check (min_word_count is null or min_word_count >= 1),
  add column if not exists max_word_count integer check (max_word_count is null or max_word_count >= 1);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guild_events_word_range_chk') then
    alter table guild_events
      add constraint guild_events_word_range_chk
      check (min_word_count is null or max_word_count is null or min_word_count <= max_word_count);
  end if;
end $$;

-- ------------------------------------------------------------------------------------------------
-- 2. create_guild_event_draft / update_guild_event_draft — two new optional params.
-- Byte-for-byte the same as the current final definitions in schema.sql, except:
--   - two new params, p_min_word_count / p_max_word_count, both integer default null
--   - a check that a word range can only be set on a writing_contest event (the UI already only
--     ever shows these fields for that type; this is the server backstop for that)
--   - the two new columns added to the insert / update
-- ------------------------------------------------------------------------------------------------

create or replace function create_guild_event_draft(
  p_guild_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null,
  p_min_word_count integer default null,
  p_max_word_count integer default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can host a guild event.');
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: the event's own stated start can't already be in the past.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  -- Migration 166: a word range only ever means something for a writing contest.
  if (p_min_word_count is not null or p_max_word_count is not null) and coalesce(p_event_type, 'other') <> 'writing_contest' then
    raise exception 'A word range can only be set on a writing contest.';
  end if;
  if p_min_word_count is not null and p_max_word_count is not null and p_min_word_count > p_max_word_count then
    raise exception 'Minimum word count can''t be higher than the maximum.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status, guaranteed_prize_kobo, min_word_count, max_word_count
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    p_entry_fee_kobo, p_participant_limit, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed', p_guaranteed_prize_kobo, p_min_word_count, p_max_word_count
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function update_guild_event_draft(
  p_guild_id uuid,
  p_event_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null,
  p_min_word_count integer default null,
  p_max_word_count integer default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can edit this event.');
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Only a draft or rejected event can be edited.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: same past-start-date check as create_guild_event_draft above — an edit can
  -- just as easily set (or leave) a stale date as a first save can.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  -- Migration 166: same word-range checks as create_guild_event_draft above.
  if (p_min_word_count is not null or p_max_word_count is not null) and coalesce(p_event_type, 'other') <> 'writing_contest' then
    raise exception 'A word range can only be set on a writing contest.';
  end if;
  if p_min_word_count is not null and p_max_word_count is not null and p_min_word_count > p_max_word_count then
    raise exception 'Minimum word count can''t be higher than the maximum.';
  end if;

  update guild_events set
    title = trim(p_title),
    description = nullif(trim(coalesce(p_description, '')), ''),
    rules = nullif(trim(coalesce(p_rules, '')), ''),
    event_type = coalesce(p_event_type, 'other'),
    entry_fee_kobo = p_entry_fee_kobo,
    participant_limit = p_participant_limit,
    prize_structure = coalesce(p_prize_structure, '[]'::jsonb),
    guild_share_bps = coalesce(p_guild_share_bps, 0),
    start_date = p_start_date,
    end_date = p_end_date,
    organizer_id = p_organizer_id,
    cover_image_url = p_cover_image_url,
    guaranteed_prize_kobo = p_guaranteed_prize_kobo,
    min_word_count = p_min_word_count,
    max_word_count = p_max_word_count,
    approval_status = 'draft',
    rejection_reason = null,
    reviewed_by = null,
    reviewed_at = null,
    submitted_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- Old 14-arg signatures are gone the moment the 16-arg versions above are created (Postgres
-- overloads by full argument list, and nothing else in this schema calls create_guild_event_draft/
-- update_guild_event_draft with the old signature — every caller goes through
-- lib/guild-events.js's toEventRpcArgs, which is updated in the same change as this migration).
-- Drop them explicitly anyway so two overloads never sit side by side in the catalog.
drop function if exists create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint);
drop function if exists update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint);

revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer) from public;
grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer) to authenticated;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer) from public;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer) to authenticated;

-- ------------------------------------------------------------------------------------------------
-- 3. submit_guild_event_submission — reject an out-of-range word count server-side. Everything
-- else here is byte-for-byte the current final definition; only the one new check block is added.
-- ------------------------------------------------------------------------------------------------

create or replace function submit_guild_event_submission(
  p_event_id uuid, p_title text, p_word_count integer, p_content jsonb
)
returns guild_event_submissions
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_submissions%rowtype;
  v_word_count integer;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not take submissions here.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'This event is not currently accepting submissions.';
  end if;
  if not exists (
    select 1 from guild_event_entries
    where event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
  ) then
    raise exception 'Enter this event before submitting your work.';
  end if;
  if p_content is not null and octet_length(p_content::text) > 20971520 then
    raise exception 'Submission is too large (20MB limit).';
  end if;

  v_word_count := coalesce(p_word_count, 0);
  -- Migration 166: the range set on the event, not anything the client claims about itself, is
  -- what's enforced here — a client-only check is one direct RPC call away from being bypassed.
  if v_event.min_word_count is not null and v_word_count < v_event.min_word_count then
    raise exception 'This entry needs at least % words.', v_event.min_word_count;
  end if;
  if v_event.max_word_count is not null and v_word_count > v_event.max_word_count then
    raise exception 'This entry needs to stay under % words.', v_event.max_word_count;
  end if;

  insert into guild_event_submissions (event_id, entrant_id, title, word_count, content, submitted_at, updated_at)
  values (p_event_id, auth.uid(), nullif(p_title, ''), v_word_count, p_content, now(), now())
  on conflict (event_id, entrant_id) do update set
    title = excluded.title, word_count = excluded.word_count, content = excluded.content, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function submit_guild_event_submission(uuid, text, integer, jsonb) from public;
grant execute on function submit_guild_event_submission(uuid, text, integer, jsonb) to authenticated;
