-- 179_migration_inkroot_official_question_bank.sql
--
-- The Inkroot-wide (official) question bank: backend spec section 2a, "Inkroot official events" column.
-- 174 built the per-guild bank and left this one out on purpose. Needs 178 (the 'quiz_suggest' rate limit).
--
-- What the spec asks for, and what this does:
--   * Any Inkroot admin can suggest a question; any OTHER admin approves it. The author can never approve
--     their own question (a hard rule here; the spec allowed it to be softer for guild events, and the guild
--     bank keeps its own rules, unchanged).
--   * Questions live in the same table as the guild banks, told apart by a new column scope
--     ('guild' | 'inkroot'). An official question has no guild and no anthology (guild_id and anthology_id
--     are null), so it can later go into an official event's pool through the SAME pool table, attempt and
--     grading code the guild quizzes already use.
--   * Keys stay unreadable to every client: guild_quiz_questions has RLS on and no policies, so official
--     rows are as closed as guild rows. Admins see keys only through the functions below.
--   * Editing an approved question sends it back to 'pending' and takes it out of any pool that hasn't
--     opened yet; a question used by an open or finished event can't be edited or removed (same rule as 174).
--   * Same limits as the guild bank: 10 pending per admin (guild_quiz_member_suggestion_cap()) plus the
--     20-an-hour 'quiz_suggest' rate limit from 178.
--
-- "Admin" means a real signed-in platform admin. is_inkroot_admin() is ALSO true for a call with no user
-- session (service role / SQL editor), which would make "not your own question" meaningless and leave
-- author_id null, so every function here requires auth.uid() is not null as well.
--
-- Two guild functions get a one-line guard so an official question can never reach a guild event:
--   * guild_quiz_attach_to_pool() (176's body): 'when v_q.scope <> 'guild''. Without it a null guild_id
--     makes `v_q.guild_id <> v_event.guild_id` null (not true), so an official question would fall through
--     the checks and be attached.
--   * edit_guild_quiz_question() (174's body): refuses an official question. The other guild functions
--     that take a question id (remove/review) already stop at guild_officer_gate('Guild not found.').
--
-- NOT built here (needs a decision first): an official event that actually PLAYS these questions. Today an
-- Inkroot-hosted event (host = 'inkroot') is created active/open in one step by an admin, has no entry fee
-- and no entry row, so start_guild_quiz_attempt() (which needs a paid entry) and the pool/settings/gate
-- functions (all host = 'guild') don't apply to it. Not run against a live database. Safe to apply once
-- (create-or-replace, if-not-exists, and the constraint is dropped and re-added).

-- 1. Schema ------------------------------------------------------------------------------------
alter table guild_quiz_questions
  add column if not exists scope text not null default 'guild' check (scope in ('guild', 'inkroot'));

alter table guild_quiz_questions alter column guild_id drop not null;

alter table guild_quiz_questions drop constraint if exists guild_quiz_questions_scope_shape;
alter table guild_quiz_questions add constraint guild_quiz_questions_scope_shape check (
  (scope = 'guild' and guild_id is not null)
  or (scope = 'inkroot' and guild_id is null and anthology_id is null)
);

create index if not exists guild_quiz_questions_official_idx
  on guild_quiz_questions (status, created_at) where scope = 'inkroot';

-- 2. Guards on the guild functions ---------------------------------------------------------------
create or replace function guild_quiz_attach_to_pool(p_event_id uuid, p_question_id uuid, p_strict boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_q guild_quiz_questions%rowtype;
  v_reason text;
begin
  select * into v_event from guild_events where id = p_event_id;
  select * into v_q from guild_quiz_questions where id = p_question_id;

  perform pg_advisory_xact_lock(hashtext('guild_event_quiz_pool:' || p_event_id::text));
  if exists (select 1 from guild_event_quiz_pool where event_id = p_event_id and question_id = p_question_id) then
    return true;
  end if;

  v_reason := case
    when v_event.id is null or v_q.id is null then 'Question or event not found.'
    -- Migration 179: an Inkroot-wide (official) question never goes into a guild event's pool. Without
    -- this, a null guild_id makes the comparison below null (not true) and the question would slip through.
    when v_q.scope <> 'guild' then 'That question belongs to a different question bank.'
    -- Migration 176: a tournament draws from the same pool.
    when v_event.host <> 'guild' or v_event.event_type not in ('reading_challenge', 'tournament') then 'Questions only apply to a Reading & Trivia or Tournament event.'
    when not guild_quiz_questions_editable(v_event.approval_status) then 'The questions are locked once the event is with Inkroot or open.'
    when guild_quiz_event_source(v_event) is null then 'Choose the quiz''s book (or no book) before adding questions.'
    when v_q.guild_id <> v_event.guild_id or v_q.anthology_id is distinct from guild_quiz_event_anthology(v_event)
      then 'That question belongs to a different question bank.'
    when v_q.status <> 'approved' then 'Only approved questions can go into a quiz.'
    when v_q.author_id is not null and exists (
      select 1 from guild_event_entries where event_id = p_event_id and entrant_id = v_q.author_id
    ) then 'The writer of that question has already entered this quiz.'
    when (select count(*) from guild_event_quiz_pool where event_id = p_event_id) >= (case when v_event.event_type = 'tournament' then guild_tournament_question_cap() else guild_quiz_question_cap() end)
      then format('A quiz can have at most %s questions.', (case when v_event.event_type = 'tournament' then guild_tournament_question_cap() else guild_quiz_question_cap() end))
    else null
  end;

  if v_reason is not null then
    if p_strict then
      raise exception '%', v_reason;
    end if;
    return false;
  end if;

  insert into guild_event_quiz_pool (event_id, question_id, sort_order)
  values (p_event_id, p_question_id,
    coalesce((select max(sort_order) from guild_event_quiz_pool where event_id = p_event_id), 0) + 1);
  return true;
end;
$$;

revoke all on function guild_quiz_attach_to_pool(uuid, uuid, boolean) from public, anon, authenticated;

create or replace function edit_guild_quiz_question(
  p_question_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
  v_options jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to edit a question.';
  end if;
  select * into v_q from guild_quiz_questions where id = p_question_id for update;
  if not found then
    raise exception 'Question not found.';
  end if;
  -- Migration 179: official questions are edited through edit_inkroot_quiz_question() only.
  if v_q.scope <> 'guild' then
    raise exception 'Question not found.';
  end if;
  if not (coalesce(v_q.author_id = auth.uid(), false) or is_guild_officer(v_q.guild_id)) then
    raise exception 'Only the writer or a guild officer can edit this question.';
  end if;
  if exists (
    select 1 from guild_event_quiz_pool p
    join guild_events e on e.id = p.event_id
    where p.question_id = p_question_id and not guild_quiz_questions_editable(e.approval_status)
  ) then
    raise exception 'This question is used by an event that is open or finished, so it can''t be changed. Write a new one instead.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  perform pg_advisory_xact_lock(hashtext('guild_quiz_pending:' || v_q.guild_id::text || ':' || coalesce(v_q.author_id::text, '')));
  if v_q.status <> 'pending' and v_q.author_id is not null and (
    select count(*) from guild_quiz_questions x
    where x.guild_id = v_q.guild_id and x.author_id = v_q.author_id and x.origin = 'member' and x.status = 'pending'
  ) >= guild_quiz_member_suggestion_cap() then
    raise exception 'You can have at most % questions waiting for review.', guild_quiz_member_suggestion_cap();
  end if;

  delete from guild_event_quiz_pool where question_id = p_question_id;
  update guild_quiz_questions
    set prompt = trim(p_prompt), options = v_options, correct_option_id = trim(p_correct_option_id),
        status = 'pending', reviewed_by = null, reviewed_at = null
  where id = p_question_id;
end;
$$;
revoke all on function edit_guild_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function edit_guild_quiz_question(uuid, text, jsonb, text) to authenticated;

-- 3. Official bank -----------------------------------------------------------------------------
-- The one admin check. Internal: only the security-definer functions below call it.
create or replace function inkroot_quiz_admin_gate(p_denied_message text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not is_inkroot_admin() then
    raise exception '%', p_denied_message;
  end if;
end;
$$;
revoke all on function inkroot_quiz_admin_gate(text) from public, anon, authenticated;

-- An admin suggests an official question. Lands 'pending'; a different admin approves it.
create or replace function suggest_inkroot_quiz_question(p_prompt text, p_options jsonb, p_correct_option_id text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_options jsonb;
  v_id uuid;
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can suggest official questions.');
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  perform check_and_bump_rate_limit('quiz_suggest');

  perform pg_advisory_xact_lock(hashtext('inkroot_quiz_pending:' || auth.uid()::text));
  if (select count(*) from guild_quiz_questions x
      where x.scope = 'inkroot' and x.author_id = auth.uid() and x.status = 'pending')
     >= guild_quiz_member_suggestion_cap() then
    raise exception 'You can have at most % questions waiting for review.', guild_quiz_member_suggestion_cap();
  end if;

  -- origin 'member' = "suggested, not approved on the spot"; scope says whose bank it is.
  insert into guild_quiz_questions (event_id, guild_id, anthology_id, scope, author_id, origin, status, prompt, options, correct_option_id)
  values (null, null, null, 'inkroot', auth.uid(), 'member', 'pending', trim(p_prompt), v_options, trim(p_correct_option_id))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function suggest_inkroot_quiz_question(text, jsonb, text) from public, anon;
grant execute on function suggest_inkroot_quiz_question(text, jsonb, text) to authenticated;

-- Approve or reject a pending official question. Never the author.
create or replace function review_inkroot_quiz_question(p_question_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can review official questions.');
  select * into v_q from guild_quiz_questions where id = p_question_id and scope = 'inkroot' for update;
  if not found then
    raise exception 'Question not found.';
  end if;
  if v_q.status <> 'pending' then
    raise exception 'This suggestion has already been reviewed.';
  end if;
  if v_q.author_id = auth.uid() then
    raise exception 'You wrote this question, so another admin has to review it.';
  end if;
  update guild_quiz_questions
    set status = case when coalesce(p_approve, false) then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_question_id;
end;
$$;
revoke all on function review_inkroot_quiz_question(uuid, boolean) from public, anon;
grant execute on function review_inkroot_quiz_question(uuid, boolean) to authenticated;

-- Change an official question ("edit, then approve" is this call followed by a review). Any admin can
-- edit; it goes back to 'pending', so it needs a fresh review (never by its own author).
create or replace function edit_inkroot_quiz_question(
  p_question_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
  v_options jsonb;
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can edit official questions.');
  select * into v_q from guild_quiz_questions where id = p_question_id and scope = 'inkroot' for update;
  if not found then
    raise exception 'Question not found.';
  end if;
  if exists (
    select 1 from guild_event_quiz_pool p
    join guild_events e on e.id = p.event_id
    where p.question_id = p_question_id and not guild_quiz_questions_editable(e.approval_status)
  ) then
    raise exception 'This question is used by an event that is open or finished, so it can''t be changed. Write a new one instead.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  -- Bringing a reviewed question back to 'pending' takes up one of its author's waiting slots.
  perform pg_advisory_xact_lock(hashtext('inkroot_quiz_pending:' || coalesce(v_q.author_id::text, '')));
  if v_q.status <> 'pending' and v_q.author_id is not null and (
    select count(*) from guild_quiz_questions x
    where x.scope = 'inkroot' and x.author_id = v_q.author_id and x.status = 'pending'
  ) >= guild_quiz_member_suggestion_cap() then
    raise exception 'That question''s writer already has % questions waiting for review.', guild_quiz_member_suggestion_cap();
  end if;

  delete from guild_event_quiz_pool where question_id = p_question_id;
  update guild_quiz_questions
    set prompt = trim(p_prompt), options = v_options, correct_option_id = trim(p_correct_option_id),
        status = 'pending', reviewed_by = null, reviewed_at = null
  where id = p_question_id;
end;
$$;
revoke all on function edit_inkroot_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function edit_inkroot_quiz_question(uuid, text, jsonb, text) to authenticated;

-- Delete an official question. Refused while an open or finished event uses it.
create or replace function remove_inkroot_quiz_question(p_question_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can remove official questions.');
  if not exists (select 1 from guild_quiz_questions where id = p_question_id and scope = 'inkroot') then
    raise exception 'Question not found.';
  end if;
  if exists (
    select 1 from guild_event_quiz_pool p
    join guild_events e on e.id = p.event_id
    where p.question_id = p_question_id and not guild_quiz_questions_editable(e.approval_status)
  ) then
    raise exception 'This question is used by an event that is open or finished, so it can''t be removed.';
  end if;
  delete from guild_quiz_questions where id = p_question_id and scope = 'inkroot';
end;
$$;
revoke all on function remove_inkroot_quiz_question(uuid) from public, anon;
grant execute on function remove_inkroot_quiz_question(uuid) to authenticated;

-- The whole official bank for admins, keys included. p_status null = every status; the review queue is
-- p_status = 'pending' (is_mine lets the screen hide Approve on the caller's own questions).
create or replace function list_inkroot_quiz_bank(p_status text default null)
returns table (
  id uuid, author_id uuid, origin text, status text, prompt text, options jsonb,
  correct_option_id text, times_used integer, is_mine boolean, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can see the official question bank.');
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'Unknown status.';
  end if;
  return query
    select q.id, q.author_id, q.origin, q.status, q.prompt, q.options, q.correct_option_id,
           (select count(*)::integer from guild_event_quiz_pool p where p.question_id = q.id),
           coalesce(q.author_id = auth.uid(), false),
           q.created_at
    from guild_quiz_questions q
    where q.scope = 'inkroot' and (p_status is null or q.status = p_status)
    order by case q.status when 'pending' then 0 when 'approved' then 1 else 2 end, q.created_at;
end;
$$;
revoke all on function list_inkroot_quiz_bank(text) from public, anon;
grant execute on function list_inkroot_quiz_bank(text) to authenticated;

-- What this admin wrote, any status (they wrote the key, so it comes back).
create or replace function list_my_inkroot_quiz_questions()
returns table (
  id uuid, status text, prompt text, options jsonb, correct_option_id text, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can see official questions.');
  return query
    select q.id, q.status, q.prompt, q.options, q.correct_option_id, q.created_at
    from guild_quiz_questions q
    where q.scope = 'inkroot' and q.author_id = auth.uid()
    order by q.created_at;
end;
$$;
revoke all on function list_my_inkroot_quiz_questions() from public, anon;
grant execute on function list_my_inkroot_quiz_questions() to authenticated;

-- "12 questions ready" for the admin screen. Counts only.
create or replace function get_inkroot_bank_counts()
returns table (approved_count integer, pending_count integer)
language plpgsql stable security definer set search_path = public as $$
begin
  perform inkroot_quiz_admin_gate('Only an Inkroot admin can see the official question bank.');
  return query
    select (count(*) filter (where q.status = 'approved'))::integer,
           (count(*) filter (where q.status = 'pending'))::integer
    from guild_quiz_questions q
    where q.scope = 'inkroot';
end;
$$;
revoke all on function get_inkroot_bank_counts() from public, anon;
grant execute on function get_inkroot_bank_counts() to authenticated;
