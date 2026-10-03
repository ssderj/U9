-- 178_migration_quiz_suggestion_rate_limit.sql
--
-- Closes a gap in the backend spec's section 2a: suggest_quiz_question must enforce "a per-person cap
-- (10 waiting at a time) AND a rate limit so nobody floods the bank". 174 shipped the cap
-- (guild_quiz_member_suggestion_cap() = 10, counted across the guild's whole bank) but no rate limit.
-- The cap alone can be cycled: suggest 10, an officer rejects/approves, suggest 10 more, and so on.
--
-- Change: a new server-side limit 'quiz_suggest' (20 an hour per person - the same fixed-window
-- mechanism as 98/101/171; the numbers live inside check_and_bump_rate_limit(), never in the client)
-- and one check_and_bump_rate_limit('quiz_suggest') call in each member-facing suggest function, placed
-- AFTER input validation and BEFORE the insert, so a rejected form doesn't use up a slot and a failed
-- call rolls the counter back with it.
--   * suggest_guild_quiz_question()  - body is 176's (it supersedes 174's; tournaments included)
--   * suggest_guild_bank_question()  - body is 174's (the "+ Add a question" button, no event)
-- NOT limited on purpose: host_add_guild_quiz_question / host_add_guild_bank_question (officers, already
-- trusted to approve their own questions) and edit_guild_quiz_question (bounded by the same cap).
-- check_and_bump_rate_limit() is 171's body (giveaway_tap included) plus the one new case line.
-- Nothing else changes. Not run against a live database. Safe to apply once (all create-or-replace).

create or replace function check_and_bump_rate_limit(p_action text)
returns void as $$
declare
  v_uid uuid := auth.uid();
  v_max_calls integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  -- Server-side limits. To change one, edit it here — never accept it from the caller.
  case p_action
    when 'init_purchase'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'download_book'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_event_entry'     then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_hosting_fee'     then v_max_calls := 10; v_window_seconds := 3600;
    when 'list_banks'           then v_max_calls := 30; v_window_seconds := 3600;
    when 'init_pack_purchase'   then v_max_calls := 20; v_window_seconds := 3600;
    when 'resolve_bank_account' then v_max_calls := 10; v_window_seconds := 3600;
    when 'storage_upload'       then v_max_calls := 60; v_window_seconds := 3600;
    when 'join_guild'           then v_max_calls := 20; v_window_seconds := 3600;
    -- Migration 171: giveaway tickets — 10 taps a minute per person (the 100-ticket cap is separate).
    when 'giveaway_tap'         then v_max_calls := 10; v_window_seconds := 60;
    -- Migration 178: suggesting quiz questions - 20 an hour per person. The 10-waiting cap in the suggest
    -- functions is the real bound; this only stops someone scripting a flood of suggest/approve/suggest.
    when 'quiz_suggest'         then v_max_calls := 20; v_window_seconds := 3600;
    else
      raise exception 'Unknown rate limit action.';
  end case;

  perform pg_advisory_xact_lock(hashtext('api_rate_limit:' || v_uid::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from api_rate_limits where user_id = v_uid and action = p_action;

  if v_window_start is null or now() - v_window_start > (v_window_seconds || ' seconds')::interval then
    insert into api_rate_limits (user_id, action, window_start, call_count)
    values (v_uid, p_action, now(), 1)
    on conflict (user_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= v_max_calls then
    raise exception 'Too many requests — please slow down and try again shortly.';
  end if;

  update api_rate_limits set call_count = call_count + 1
  where user_id = v_uid and action = p_action;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function check_and_bump_rate_limit(text) to authenticated;

create or replace function suggest_guild_quiz_question(
  p_event_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_options jsonb;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to suggest a question.';
  end if;
  if is_banned(auth.uid()) then
    raise exception 'This account can''t suggest questions.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  -- Migration 176: members can suggest for a tournament's pool too.
  if not found or v_event.host <> 'guild' or v_event.event_type not in ('reading_challenge', 'tournament') then
    raise exception 'Guild event not found.';
  end if;
  if not (is_guild_member(v_event.guild_id) or is_guild_officer(v_event.guild_id)) then
    raise exception 'Only members of the hosting guild can suggest questions.';
  end if;
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'This quiz isn''t taking suggestions any more.';
  end if;
  if guild_quiz_event_source(v_event) is null then
    raise exception 'The host hasn''t chosen the quiz''s book yet.';
  end if;
  if exists (select 1 from guild_event_entries where event_id = p_event_id and entrant_id = auth.uid()) then
    raise exception 'You''ve entered this quiz, so you can''t write for it.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  -- Migration 178: rate limit (after validation, so a rejected form doesn't use up a slot).
  perform check_and_bump_rate_limit('quiz_suggest');

  perform pg_advisory_xact_lock(hashtext('guild_quiz_pending:' || v_event.guild_id::text || ':' || auth.uid()::text));
  if (select count(*) from guild_quiz_questions x
      where x.guild_id = v_event.guild_id and x.author_id = auth.uid() and x.origin = 'member' and x.status = 'pending')
     >= guild_quiz_member_suggestion_cap() then
    raise exception 'You can have at most % questions waiting for review.', guild_quiz_member_suggestion_cap();
  end if;

  insert into guild_quiz_questions (event_id, guild_id, anthology_id, author_id, origin, status, prompt, options, correct_option_id)
  values (p_event_id, v_event.guild_id, guild_quiz_event_anthology(v_event), auth.uid(), 'member', 'pending',
          trim(p_prompt), v_options, trim(p_correct_option_id))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function suggest_guild_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function suggest_guild_quiz_question(uuid, text, jsonb, text) to authenticated;

create or replace function suggest_guild_bank_question(
  p_guild_id uuid, p_anthology_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_options jsonb;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to suggest a question.';
  end if;
  if is_banned(auth.uid()) then
    raise exception 'This account can''t suggest questions.';
  end if;
  if not (is_guild_member(p_guild_id) or is_guild_officer(p_guild_id)) then
    raise exception 'Only members of this guild can suggest questions.';
  end if;
  if p_anthology_id is not null and not exists (
    select 1 from guild_anthologies a where a.id = p_anthology_id and a.guild_id = p_guild_id
  ) then
    raise exception 'Choose one of this guild''s own anthologies.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  -- Migration 178: rate limit (after validation, so a rejected form doesn't use up a slot).
  perform check_and_bump_rate_limit('quiz_suggest');

  perform pg_advisory_xact_lock(hashtext('guild_quiz_pending:' || p_guild_id::text || ':' || auth.uid()::text));
  if (select count(*) from guild_quiz_questions x
      where x.guild_id = p_guild_id and x.author_id = auth.uid() and x.origin = 'member' and x.status = 'pending')
     >= guild_quiz_member_suggestion_cap() then
    raise exception 'You can have at most % questions waiting for review.', guild_quiz_member_suggestion_cap();
  end if;

  insert into guild_quiz_questions (event_id, guild_id, anthology_id, author_id, origin, status, prompt, options, correct_option_id)
  values (null, p_guild_id, p_anthology_id, auth.uid(), 'member', 'pending', trim(p_prompt), v_options, trim(p_correct_option_id))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function suggest_guild_bank_question(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function suggest_guild_bank_question(uuid, uuid, text, jsonb, text) to authenticated;
