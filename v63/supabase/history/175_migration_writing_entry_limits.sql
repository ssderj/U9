-- 175_migration_writing_entry_limits.sql
--
-- Writing contest (backend spec, section 4). Nearly all of it already shipped: migration 166 added the
-- word range, 170 counts the words on the server (stripping the HTML itself, so the client's number is
-- never read) and accepts {text} or {text, projectId, projectTitle}, and 172 kept that. This closes the
-- two loose ends that were left:
--
--   1. SIZE. Text was limited to 1,000,000 characters, but the JSON around it only to 20MB, so an entry
--      could carry megabytes of junk in another key. A written entry is now capped at 5MB of JSON.
--   2. THE PROJECT LABELS. projectId and projectTitle are only labels shown back to the entrant and the
--      judges, and had no limit. projectId must be a string of at most 100 characters and projectTitle
--      a string of at most 200 (the app's own titles are far shorter). A direct call that sends
--      something else is refused; the app is unaffected.
--
-- Nothing else changes: this is migration 172's submit_guild_event_submission() with those two checks
-- added (marked "Migration 175"), so 172's quiz refusal and 170's word counting stay exactly as they were.
-- The front-end half of the same fix is in guild-event-writing-panel.jsx: a linked project is now sent
-- as plain text, not the chapters' stored HTML, so judges read words rather than <div> tags.
--
-- Confirming 166 is applied is a check, not a change; see section 0 of the two-account checklist.
-- Not run against a live database. Safe to apply once; create-or-replace.

create or replace function submit_guild_event_submission(
  p_event_id uuid, p_title text, p_word_count integer, p_content jsonb
)
returns guild_event_submissions
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_submissions%rowtype;
  v_word_count integer;
  v_text text;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not take submissions here.';
  end if;
  -- Migration 172: a quiz is answered through submit_guild_quiz_attempt() (server-graded). A hand-made
  -- submission row could otherwise put someone in the ranking without an attempt. (A legacy
  -- reading challenge with no quiz settings keeps the old path.)
  if v_event.event_type = 'reading_challenge' and v_event.quiz_time_limit_seconds is not null then
    raise exception 'Quiz answers are submitted through the quiz itself.';
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

  -- Migration 170: content is {text} or {text, projectId, projectTitle} for writing entries (other
  -- shapes, like a world-building piece, carry no text). The words are counted here.
  v_text := case when p_content is not null and jsonb_typeof(p_content) = 'object'
                  and jsonb_typeof(p_content->'text') = 'string' then p_content->>'text' end;
  if v_text is not null then
    if char_length(v_text) > 1000000 then
      raise exception 'This entry is too long to submit.';
    end if;
    v_word_count := guild_event_count_words(v_text);
    -- Migration 175: the 20MB ceiling above is for non-text pieces. A written entry is at most 1,000,000
    -- characters, so anything much bigger than that is padding hidden in another key.
    if octet_length(p_content::text) > 5000000 then
      raise exception 'This entry is too large to submit.';
    end if;
    -- The linked-project fields are labels, not content. (Migration 175: they had no limit at all.)
    if jsonb_typeof(p_content->'projectId') is not null
       and (jsonb_typeof(p_content->'projectId') <> 'string' or char_length(p_content->>'projectId') > 100) then
      raise exception 'The linked project''s id is not valid.';
    end if;
    if jsonb_typeof(p_content->'projectTitle') is not null
       and (jsonb_typeof(p_content->'projectTitle') <> 'string' or char_length(p_content->>'projectTitle') > 200) then
      raise exception 'The linked project''s title is too long (200 characters at most).';
    end if;
  else
    if v_event.min_word_count is not null or v_event.max_word_count is not null then
      raise exception 'This event has a word range, so your entry needs written text.';
    end if;
    -- No text, no words to count — never trust the client's number here (audit fix).
    v_word_count := 0;
  end if;

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
revoke all on function submit_guild_event_submission(uuid, text, integer, jsonb) from public, anon;
grant execute on function submit_guild_event_submission(uuid, text, integer, jsonb) to authenticated;
