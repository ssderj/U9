-- 172_migration_quiz_backend.sql
--
-- The Reading & Trivia (quiz) event type — reading_challenge in the database — end to end, on the
-- rules the app owner confirmed:
--
--   * Polls only: every question is a prompt with 2-6 options and exactly one correct option. The
--     source is the hosting guild's own anthology, or no book at all (trivia).
--   * ONE OVERALL TIME LIMIT per attempt, set by the host (30 seconds to 2 hours). The clock is the
--     server's: start_guild_quiz_attempt() stamps started_at, submit_guild_quiz_attempt() measures
--     the elapsed time itself. A client-reported time is never read. One attempt per entrant; a
--     refresh resumes the same running attempt instead of starting a new one.
--   * HIDDEN ANSWER KEYS. guild_quiz_questions has RLS on and no policy, so no client can read it.
--     Entrants get questions + options only through start_guild_quiz_attempt(); the key is read only
--     inside the grading function and by list_guild_quiz_questions_for_host() (officers) and
--     list_my_guild_quiz_suggestions() (the writer's own suggestions).
--   * TEAM-WRITTEN QUESTIONS. Members of the hosting guild may suggest questions (3 each, 30 per quiz
--     counting the host's own and pending ones — a rejected suggestion frees its slot). The host
--     reviews: approve or reject. Only approved questions are ever served or graded. The question
--     set is frozen the moment the event opens; anything still pending is rejected then.
--   * SCORE-BASED WINNERS. Score = correct answers; ties go to the fastest server-measured time,
--     then the earliest submission. This is the 'quiz_score' judge-free metric from migration 169 at
--     weight 10000 — compute_guild_event_placements() below now knows how to rank it, and (being
--     judge-free) it pays through the 168 escrow payout the moment the host/Inkroot computes it.
--   * Question writers can't enter the quiz they wrote for (a trigger on guild_event_entries). Members
--     of the hosting guild already can't enter (migration 169).
--
-- Also here: the type is switched on in guild_event_type_backend_ready(); the public listing returns
-- the quiz fields (never the questions); the generic submit RPC refuses a quiz event so a score can't
-- be faked with a hand-made submission; quiz settings are set through set_guild_quiz_settings()
-- (a separate call after the draft is saved) so the draft RPCs stay untouched.
--
-- ASSUMPTIONS to confirm: a quiz needs at least 5 approved questions to open (guild_quiz_min_questions());
-- a 5-second grace on the time limit for network delay (guild_quiz_grace_seconds()); the entry stays
-- paid (the existing entry flow is unchanged). Unlike a giveaway, a quiz is NOT auto-computed when
-- it completes — the host or Inkroot presses compute, as for any other event.
-- Not run against a live database. Safe to apply once; functions are create-or-replace.

-- 1. Schema ------------------------------------------------------------------------------------
alter table guild_events
  add column if not exists quiz_source text check (quiz_source is null or quiz_source in ('anthology', 'none')),
  add column if not exists quiz_anthology_id uuid references guild_anthologies(id) on delete set null,
  add column if not exists quiz_time_limit_seconds integer
    check (quiz_time_limit_seconds is null or quiz_time_limit_seconds between 30 and 7200);
alter table guild_events drop constraint if exists guild_events_quiz_only_reading_challenge;
alter table guild_events add constraint guild_events_quiz_only_reading_challenge
  check (
    (quiz_source is null and quiz_anthology_id is null and quiz_time_limit_seconds is null)
    or event_type = 'reading_challenge'
  );

create table if not exists guild_quiz_questions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  origin text not null check (origin in ('host', 'member')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  prompt text not null check (char_length(prompt) between 3 and 500),
  options jsonb not null,               -- [{"id": "a", "text": "..."}, ...]
  correct_option_id text not null,      -- the answer key: never returned to an entrant
  sort_order integer not null default 0,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table guild_quiz_questions enable row level security;
-- No policies at all: nothing here is readable or writable by a client. Every read/write goes
-- through the security-definer functions below.
create index if not exists guild_quiz_questions_event_idx on guild_quiz_questions (event_id, status);
create index if not exists guild_quiz_questions_author_idx on guild_quiz_questions (author_id);

create table if not exists guild_quiz_attempts (
  event_id uuid not null references guild_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  answers jsonb,
  score integer,
  total integer,
  elapsed_ms integer,
  primary key (event_id, user_id)
);
alter table guild_quiz_attempts enable row level security;
-- No policies: read your own through get_my_guild_quiz_attempt().

-- 2. Constants -----------------------------------------------------------------------------------
create or replace function guild_quiz_member_suggestion_cap() returns integer as $$ select 3; $$ language sql immutable;
create or replace function guild_quiz_question_cap() returns integer as $$ select 30; $$ language sql immutable;
create or replace function guild_quiz_min_questions() returns integer as $$ select 5; $$ language sql immutable;
create or replace function guild_quiz_grace_seconds() returns integer as $$ select 5; $$ language sql immutable;
revoke all on function guild_quiz_member_suggestion_cap(), guild_quiz_question_cap(),
  guild_quiz_min_questions(), guild_quiz_grace_seconds() from public, anon, authenticated;

-- The stages in which the question set may still change (before the event opens; not while Inkroot
-- is reviewing it).
create or replace function guild_quiz_questions_editable(p_approval_status text)
returns boolean as $$ select p_approval_status in ('draft', 'rejected', 'approved', 'published'); $$ language sql immutable;
revoke all on function guild_quiz_questions_editable(text) from public, anon, authenticated;

-- Validates and normalises a poll: 2-6 options, unique short ids, non-empty text, one correct id.
create or replace function guild_quiz_clean_options(p_options jsonb, p_correct text)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_elem jsonb;
  v_id text;
  v_text text;
  v_ids text[] := '{}';
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' then
    raise exception 'A question needs a list of options.';
  end if;
  if jsonb_array_length(p_options) < 2 or jsonb_array_length(p_options) > 6 then
    raise exception 'A question needs between 2 and 6 options.';
  end if;
  for v_elem in select * from jsonb_array_elements(p_options) loop
    if jsonb_typeof(v_elem) <> 'object' or jsonb_typeof(v_elem->'id') <> 'string' or jsonb_typeof(v_elem->'text') <> 'string' then
      raise exception 'Each option needs an id and some text.';
    end if;
    v_id := trim(v_elem->>'id');
    v_text := trim(v_elem->>'text');
    if char_length(v_id) < 1 or char_length(v_id) > 40 then
      raise exception 'Invalid option id.';
    end if;
    if char_length(v_text) < 1 or char_length(v_text) > 200 then
      raise exception 'Each option needs between 1 and 200 characters.';
    end if;
    if v_id = any (v_ids) then
      raise exception 'Option ids must be unique.';
    end if;
    v_ids := v_ids || v_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'text', v_text));
  end loop;
  if p_correct is null or not (trim(p_correct) = any (v_ids)) then
    raise exception 'Mark which option is correct.';
  end if;
  return v_out;
end;
$$;
revoke all on function guild_quiz_clean_options(jsonb, text) from public, anon, authenticated;

-- 3. Backend-ready switch ------------------------------------------------------------------------
create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then true
    when 'reading_challenge' then true
    when 'tournament' then false
    else true
  end;
$$ language sql immutable;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;

-- 4. Host: settings and questions ----------------------------------------------------------------
create or replace function set_guild_quiz_settings(
  p_event_id uuid, p_source text, p_anthology_id uuid, p_time_limit_seconds integer
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can set up this quiz.');
  if v_event.host <> 'guild' or v_event.event_type <> 'reading_challenge' then
    raise exception 'Quiz settings only apply to a Reading & Trivia event.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Quiz settings can only be changed while the event is a draft.';
  end if;
  if p_source is null or p_source not in ('anthology', 'none') then
    raise exception 'Choose the guild''s anthology or no book (trivia).';
  end if;
  if p_source = 'anthology' and not exists (
    select 1 from guild_anthologies a where a.id = p_anthology_id and a.guild_id = v_event.guild_id
  ) then
    raise exception 'Choose one of this guild''s own anthologies.';
  end if;
  if p_time_limit_seconds is null or p_time_limit_seconds < 30 or p_time_limit_seconds > 7200 then
    raise exception 'The time limit must be between 30 seconds and 2 hours.';
  end if;
  update guild_events
    set quiz_source = p_source,
        quiz_anthology_id = case when p_source = 'anthology' then p_anthology_id else null end,
        quiz_time_limit_seconds = p_time_limit_seconds
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function set_guild_quiz_settings(uuid, text, uuid, integer) from public, anon;
grant execute on function set_guild_quiz_settings(uuid, text, uuid, integer) to authenticated;

create or replace function host_add_guild_quiz_question(
  p_event_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_options jsonb;
  v_id uuid;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can add questions.');
  if v_event.host <> 'guild' or v_event.event_type <> 'reading_challenge' then
    raise exception 'Questions only apply to a Reading & Trivia event.';
  end if;
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'The questions are locked once the event is with Inkroot or open.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  perform pg_advisory_xact_lock(hashtext('guild_quiz_questions:' || p_event_id::text));
  if (select count(*) from guild_quiz_questions where event_id = p_event_id and status <> 'rejected') >= guild_quiz_question_cap() then
    raise exception 'A quiz can have at most % questions.', guild_quiz_question_cap();
  end if;

  insert into guild_quiz_questions (event_id, author_id, origin, status, prompt, options, correct_option_id, sort_order, reviewed_by, reviewed_at)
  values (p_event_id, auth.uid(), 'host', 'approved', trim(p_prompt), v_options, trim(p_correct_option_id),
    coalesce((select max(sort_order) from guild_quiz_questions where event_id = p_event_id), 0) + 1, auth.uid(), now())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function host_add_guild_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function host_add_guild_quiz_question(uuid, text, jsonb, text) to authenticated;

create or replace function remove_guild_quiz_question(p_question_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
  v_event guild_events%rowtype;
begin
  select * into v_q from guild_quiz_questions where id = p_question_id;
  if not found then
    raise exception 'Question not found.';
  end if;
  select * into v_event from guild_events where id = v_q.event_id;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can remove questions.');
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'The questions are locked once the event is with Inkroot or open.';
  end if;
  delete from guild_quiz_questions where id = p_question_id;
end;
$$;
revoke all on function remove_guild_quiz_question(uuid) from public, anon;
grant execute on function remove_guild_quiz_question(uuid) to authenticated;

create or replace function review_guild_quiz_question(p_question_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
  v_event guild_events%rowtype;
begin
  select * into v_q from guild_quiz_questions where id = p_question_id for update;
  if not found then
    raise exception 'Question not found.';
  end if;
  select * into v_event from guild_events where id = v_q.event_id;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can review suggested questions.');
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'The questions are locked once the event is with Inkroot or open.';
  end if;
  if v_q.status <> 'pending' then
    raise exception 'This suggestion has already been reviewed.';
  end if;
  update guild_quiz_questions
    set status = case when coalesce(p_approve, false) then 'approved' else 'rejected' end,
        sort_order = case when coalesce(p_approve, false)
          then coalesce((select max(sort_order) from guild_quiz_questions where event_id = v_q.event_id), 0) + 1
          else sort_order end,
        reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_question_id;
end;
$$;
revoke all on function review_guild_quiz_question(uuid, boolean) from public, anon;
grant execute on function review_guild_quiz_question(uuid, boolean) to authenticated;

-- Everything on the question bank, answer keys included, for the host. Officers only.
create or replace function list_guild_quiz_questions_for_host(p_event_id uuid)
returns table (
  id uuid, author_id uuid, origin text, status text, prompt text, options jsonb,
  correct_option_id text, sort_order integer, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_guild_id uuid;
begin
  select guild_id into v_guild_id from guild_events where guild_events.id = p_event_id;
  if v_guild_id is null then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_guild_id, 'Only the guild owner can see the question bank.');
  return query
    select q.id, q.author_id, q.origin, q.status, q.prompt, q.options, q.correct_option_id, q.sort_order, q.created_at
    from guild_quiz_questions q
    where q.event_id = p_event_id
    order by case q.status when 'pending' then 0 when 'approved' then 1 else 2 end, q.sort_order, q.created_at;
end;
$$;
revoke all on function list_guild_quiz_questions_for_host(uuid) from public, anon;
grant execute on function list_guild_quiz_questions_for_host(uuid) to authenticated;

-- 5. Members: suggest questions ------------------------------------------------------------------
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
  if not found or v_event.host <> 'guild' or v_event.event_type <> 'reading_challenge' then
    raise exception 'Guild event not found.';
  end if;
  if not (is_guild_member(v_event.guild_id) or is_guild_officer(v_event.guild_id)) then
    raise exception 'Only members of the hosting guild can suggest questions.';
  end if;
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'This quiz isn''t taking suggestions any more.';
  end if;
  if exists (select 1 from guild_event_entries where event_id = p_event_id and entrant_id = auth.uid()) then
    raise exception 'You''ve entered this quiz, so you can''t write for it.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  perform pg_advisory_xact_lock(hashtext('guild_quiz_questions:' || p_event_id::text));
  if (select count(*) from guild_quiz_questions
      where event_id = p_event_id and author_id = auth.uid() and origin = 'member' and status <> 'rejected')
     >= guild_quiz_member_suggestion_cap() then
    raise exception 'You can have at most % questions in this quiz at a time.', guild_quiz_member_suggestion_cap();
  end if;
  if (select count(*) from guild_quiz_questions where event_id = p_event_id and status <> 'rejected') >= guild_quiz_question_cap() then
    raise exception 'This quiz already has the maximum of % questions.', guild_quiz_question_cap();
  end if;

  insert into guild_quiz_questions (event_id, author_id, origin, status, prompt, options, correct_option_id)
  values (p_event_id, auth.uid(), 'member', 'pending', trim(p_prompt), v_options, trim(p_correct_option_id))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function suggest_guild_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function suggest_guild_quiz_question(uuid, text, jsonb, text) to authenticated;

-- A writer's own suggestions and their status (they wrote the key, so it comes back to them).
create or replace function list_my_guild_quiz_suggestions(p_event_id uuid)
returns table (
  id uuid, status text, prompt text, options jsonb, correct_option_id text, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select q.id, q.status, q.prompt, q.options, q.correct_option_id, q.created_at
  from guild_quiz_questions q
  where q.event_id = p_event_id and q.author_id = auth.uid() and q.origin = 'member'
  order by q.created_at;
$$;
revoke all on function list_my_guild_quiz_suggestions(uuid) from public, anon;
grant execute on function list_my_guild_quiz_suggestions(uuid) to authenticated;

-- The writer of a question can't enter the quiz it is in.
create or replace function guild_quiz_block_writer_entry()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from guild_quiz_questions q
    where q.event_id = new.event_id and q.author_id = new.entrant_id and q.origin = 'member'
  ) then
    raise exception 'You wrote a question for this quiz, so you can''t enter it.';
  end if;
  return new;
end;
$$;
drop trigger if exists guild_quiz_block_writer_entry on guild_event_entries;
create trigger guild_quiz_block_writer_entry
  before insert or update of status on guild_event_entries
  for each row execute function guild_quiz_block_writer_entry();

-- Opening gate: settings + enough approved questions; the set is frozen, pending ones are rejected.
-- A trigger (not a copy of activate_guild_event) so that function keeps its single latest body.
create or replace function guild_quiz_activation_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_approved integer;
begin
  if new.host = 'guild' and new.event_type = 'reading_challenge'
     and new.approval_status = 'active' and old.approval_status is distinct from 'active' then
    if new.quiz_time_limit_seconds is null or new.quiz_source is null
       or (new.quiz_source = 'anthology' and new.quiz_anthology_id is null) then
      raise exception 'Set up this quiz (source and time limit) before opening it.';
    end if;
    select count(*) into v_approved from guild_quiz_questions where event_id = new.id and status = 'approved';
    if v_approved < guild_quiz_min_questions() then
      raise exception 'A quiz needs at least % approved questions to open (this one has %).', guild_quiz_min_questions(), v_approved;
    end if;
    update guild_quiz_questions
      set status = 'rejected', reviewed_at = now()
    where event_id = new.id and status = 'pending';
  end if;
  return new;
end;
$$;
drop trigger if exists guild_quiz_activation_gate on guild_events;
create trigger guild_quiz_activation_gate
  before update of approval_status on guild_events
  for each row execute function guild_quiz_activation_gate();

-- 6. Entrants: start, submit, read own attempt ---------------------------------------------------
create or replace function start_guild_quiz_attempt(p_event_id uuid)
returns table (
  started_at timestamptz, time_limit_seconds integer, question_count integer, questions jsonb, server_now timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_attempt guild_quiz_attempts%rowtype;
  v_questions jsonb;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in to take the quiz.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.host <> 'guild' or v_event.event_type <> 'reading_challenge'
     or v_event.quiz_time_limit_seconds is null then
    raise exception 'Quiz not found.';
  end if;
  if v_event.approval_status <> 'active' or v_event.status <> 'open'
     or (v_event.end_date is not null and now() > v_event.end_date) then
    raise exception 'This quiz isn''t open.';
  end if;
  if not exists (
    select 1 from guild_event_entries where event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
  ) then
    raise exception 'Enter this quiz before taking it.';
  end if;
  if exists (select 1 from guild_quiz_questions where event_id = p_event_id and author_id = auth.uid() and origin = 'member') then
    raise exception 'You wrote a question for this quiz, so you can''t take it.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_quiz_attempt:' || p_event_id::text || ':' || auth.uid()::text));
  select * into v_attempt from guild_quiz_attempts where event_id = p_event_id and user_id = auth.uid();
  if found then
    if v_attempt.submitted_at is not null then
      raise exception 'You''ve already taken this quiz.';
    end if;
    if now() > v_attempt.started_at + make_interval(secs => v_event.quiz_time_limit_seconds + guild_quiz_grace_seconds()) then
      raise exception 'Your time for this quiz has run out.';
    end if;
  else
    insert into guild_quiz_attempts (event_id, user_id, started_at)
    values (p_event_id, auth.uid(), now())
    returning * into v_attempt;
  end if;

  -- Questions and options only. The key column is never selected here.
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options', q.options)
           order by q.sort_order, q.created_at), '[]'::jsonb), count(*)::integer
  into v_questions, v_count
  from guild_quiz_questions q
  where q.event_id = p_event_id and q.status = 'approved';

  return query select v_attempt.started_at, v_event.quiz_time_limit_seconds, v_count, v_questions, now();
end;
$$;
revoke all on function start_guild_quiz_attempt(uuid) from public, anon;
grant execute on function start_guild_quiz_attempt(uuid) to authenticated;

create or replace function submit_guild_quiz_attempt(p_event_id uuid, p_answers jsonb)
returns table (score integer, total integer, elapsed_ms integer)
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_attempt guild_quiz_attempts%rowtype;
  v_score integer;
  v_total integer;
  v_elapsed integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in to submit your answers.';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Send your answers as {questionId: optionId}.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.event_type <> 'reading_challenge' or v_event.quiz_time_limit_seconds is null then
    raise exception 'Quiz not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_quiz_attempt:' || p_event_id::text || ':' || auth.uid()::text));
  select * into v_attempt from guild_quiz_attempts where event_id = p_event_id and user_id = auth.uid() for update;
  if not found then
    raise exception 'Start the quiz before submitting.';
  end if;
  if v_attempt.submitted_at is not null then
    raise exception 'You''ve already submitted this quiz.';
  end if;
  if now() > v_attempt.started_at + make_interval(secs => v_event.quiz_time_limit_seconds + guild_quiz_grace_seconds()) then
    raise exception 'Time''s up — your answers came in after the time limit.';
  end if;
  -- A running attempt may finish after the event closes, but not once results exist or the event
  -- is settled/cancelled, and only if it started while the quiz was open.
  if v_event.status in ('settled', 'cancelled')
     or exists (select 1 from guild_event_results where event_id = p_event_id)
     or v_attempt.started_at > coalesce(v_event.completed_at, v_event.end_date, now()) then
    raise exception 'This quiz is closed.';
  end if;

  select count(*) filter (where p_answers ->> q.id::text = q.correct_option_id), count(*)
  into v_score, v_total
  from guild_quiz_questions q
  where q.event_id = p_event_id and q.status = 'approved';

  v_elapsed := least(
    (extract(epoch from (now() - v_attempt.started_at)) * 1000)::bigint,
    v_event.quiz_time_limit_seconds::bigint * 1000
  )::integer;

  update guild_quiz_attempts
    set submitted_at = now(), answers = p_answers, score = v_score, total = v_total, elapsed_ms = v_elapsed
  where event_id = p_event_id and user_id = auth.uid();

  -- The ranking reads guild_event_submissions, so the attempt leaves a submission row behind. It
  -- carries only the score summary — never the answers.
  insert into guild_event_submissions (event_id, entrant_id, title, word_count, content, submitted_at, updated_at)
  values (p_event_id, auth.uid(), 'Quiz attempt', 0,
    jsonb_build_object('quiz', jsonb_build_object('score', v_score, 'total', v_total, 'elapsed_ms', v_elapsed)), now(), now())
  on conflict (event_id, entrant_id) do nothing;

  return query select v_score, v_total, v_elapsed;
end;
$$;
revoke all on function submit_guild_quiz_attempt(uuid, jsonb) from public, anon;
grant execute on function submit_guild_quiz_attempt(uuid, jsonb) to authenticated;

create or replace function get_my_guild_quiz_attempt(p_event_id uuid)
returns table (started_at timestamptz, submitted_at timestamptz, score integer, total integer, elapsed_ms integer)
language sql stable security definer set search_path = public as $$
  select a.started_at, a.submitted_at, a.score, a.total, a.elapsed_ms
  from guild_quiz_attempts a
  where a.event_id = p_event_id and a.user_id = auth.uid();
$$;
revoke all on function get_my_guild_quiz_attempt(uuid) from public, anon;
grant execute on function get_my_guild_quiz_attempt(uuid) to authenticated;

-- 7. Ranking: compute_guild_event_placements() is migration 169's body with two marked additions
--    (the 'quiz_score' objective and the fastest-time tie-break).
create or replace function compute_guild_event_placements(p_event_id uuid, p_exclude_judge_ids uuid[] default '{}')
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_guild_id uuid;
  v_objective guild_event_objective_config%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_assigned_count integer;
  v_quorum integer;
  v_min_scored integer;
  v_max_word_count integer;
  v_escrowed boolean;
  v_pool_bps integer;
  v_placements jsonb;
  v_row guild_event_results%rowtype;
begin
  -- Audit fix: a NULL array made "judge_id <> all (NULL)" evaluate to NULL, silently dropping EVERY
  -- judge score from the computation (and skipping the admin-only check above). Treat it as empty.
  p_exclude_judge_ids := coalesce(p_exclude_judge_ids, '{}');
  if p_exclude_judge_ids <> '{}' and not is_inkroot_admin() then
    raise exception 'Only Inkroot can exclude a judge''s scores from a computation.';
  end if;

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  v_guild_id := v_event.guild_id;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;

  -- Migration 135: the organizer, a guild treasury authority, or Inkroot — see this migration's
  -- header. Matches the caller set migration 121's own comment already described but never
  -- actually enforced.
  if not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_guild_id)
    or is_inkroot_admin()
  ) then
    raise exception 'Only this event''s organizer, a guild authority, or Inkroot can compute its placements.';
  end if;

  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before computing placements.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  select * into v_objective from guild_event_objective_config where event_id = p_event_id;
  if not found or not v_objective.locked then
    raise exception 'This event has no locked judging configuration — it cannot be settled.';
  end if;

  -- Migration 169: a judged event (any weight left on the judge panel) is computed by Inkroot only.
  -- The judges are Inkroot admins, and Inkroot must be able to drop a judge's scores and recompute
  -- BEFORE any money moves — the organizer triggering the computation could otherwise force an
  -- immediate payout (migration 168 auto-settles). Judge-free events are unaffected.
  if v_objective.weight_bps < 10000 and not is_inkroot_admin() then
    raise exception 'Results for a judged event are computed by Inkroot, not by the host guild.';
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;
  if not v_escrowed then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;
  end if;
  -- settle_guild_event() requires shares to sum to EXACTLY v_agreement.prize_pool_bps
  -- (non-escrowed) or 10000 (escrowed, paid in full — see its own header). placement_split_bps
  -- sums to 10000 at proposal time (a proportional split of "the prize pool", whatever it turns
  -- out to be) so it's scaled against v_pool_bps below, never used as the final share directly.
  v_pool_bps := case when v_escrowed then 10000 else v_agreement.prize_pool_bps end;

  if not exists (select 1 from guild_event_submissions where event_id = p_event_id) then
    raise exception 'No submissions were received for this event.';
  end if;

  -- ---- Judge quorum check (skipped entirely for a pure-objective event) ----
  if v_objective.weight_bps < 10000 then
    select count(*) into v_assigned_count
    from guild_event_judges where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids);
    if v_assigned_count < guild_event_min_judges() then
      raise exception 'Too few judges remain eligible for this event to reach quorum.';
    end if;
    v_quorum := guild_event_judge_quorum(v_assigned_count);

    select min(scored_by) into v_min_scored from (
      select s.id, count(distinct sc.judge_id) as scored_by
      from guild_event_submissions s
      left join guild_event_judge_scores sc
        on sc.submission_id = s.id and sc.judge_id <> all (p_exclude_judge_ids)
      where s.event_id = p_event_id
      group by s.id
    ) counts;
    if v_min_scored is null or v_min_scored < v_quorum then
      raise exception 'Judging quorum not yet met — at least % of % judges must score every entry (lowest so far: %).',
        v_quorum, v_assigned_count, coalesce(v_min_scored, 0);
    end if;
  end if;

  -- ---- Ranked scoring ----
  select max(word_count) into v_max_word_count from guild_event_submissions where event_id = p_event_id;

  with judge_avg as (
    -- Each judge's own average across categories for a submission, first — a judge who scores
    -- three categories doesn't get 3x the weight of one who scores a single overall category.
    select submission_id, judge_id, avg(score) as avg_score
    from guild_event_judge_scores
    where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids)
    group by submission_id, judge_id
  ),
  judge_counts as (
    select submission_id, count(*) as n_judges from judge_avg group by submission_id
  ),
  ranked_judges as (
    select ja.submission_id, ja.avg_score, jc.n_judges,
      row_number() over (partition by ja.submission_id order by ja.avg_score) as rn
    from judge_avg ja join judge_counts jc on jc.submission_id = ja.submission_id
  ),
  trimmed as (
    -- Trimmed mean across judges: drop the single highest and lowest when there are enough
    -- judges to still leave at least 3 in the middle (1 < rn < n_judges), so one outlier score
    -- (bribed, biased, or just careless) can't swing a placement on its own.
    select submission_id,
      case when n_judges >= 5
        then avg(avg_score) filter (where rn > 1 and rn < n_judges)
        else avg(avg_score)
      end as judge_score
    from ranked_judges
    group by submission_id, n_judges
  ),
  objective as (
    select s.id as submission_id,
      case v_objective.metric
        when 'word_count' then
          case when coalesce(v_max_word_count, 0) = 0 then 0
          else round(100.0 * s.word_count / v_max_word_count, 2) end
        when 'on_time_completion' then
          case when v_event.end_date is null or s.submitted_at <= v_event.end_date then 100 else 0 end
        -- Migration 172: quiz score as a percentage of the questions asked (server-graded attempt).
        when 'quiz_score' then
          coalesce((select case when a.total > 0 then round(100.0 * a.score / a.total, 2) else 0 end
                    from guild_quiz_attempts a
                    where a.event_id = s.event_id and a.user_id = s.entrant_id and a.submitted_at is not null), 0)
        else 0
      end as objective_score
    from guild_event_submissions s
    where s.event_id = p_event_id
  ),
  scored as (
    select s.id as submission_id, s.entrant_id, s.submitted_at,
      -- Migration 172: a quiz tie goes to the fastest server-measured attempt.
      (select a.elapsed_ms from guild_quiz_attempts a
       where a.event_id = s.event_id and a.user_id = s.entrant_id and a.submitted_at is not null) as quiz_elapsed_ms,
      coalesce(t.judge_score, 0) as judge_score,
      coalesce(o.objective_score, 0) as objective_score,
      coalesce(t.judge_score, 0) * (10000 - v_objective.weight_bps) / 10000.0
        + coalesce(o.objective_score, 0) * v_objective.weight_bps / 10000.0 as final_score
    from guild_event_submissions s
    left join trimmed t on t.submission_id = s.id
    left join objective o on o.submission_id = s.id
    where s.event_id = p_event_id
      -- Same "winners must be guild members" rule settle_guild_event() has always enforced
      -- (see 42_migration_guild_events.sql) — an outside entrant can compete and be ranked for
      -- the record, but only a member of the hosting guild can actually be paid a placement.
      -- Migration 168: for an escrowed event the hosting guild is the payer, so its own members are
      -- left out of the ranking entirely; every other kind of event keeps the original rule.
      and (
        case when v_escrowed
          then not exists (select 1 from player_guild_members m where m.guild_id = v_guild_id and m.user_id = s.entrant_id)
          else exists (select 1 from player_guild_members m where m.guild_id = v_guild_id and m.user_id = s.entrant_id)
        end
      )
  ),
  ranked as (
    select submission_id, entrant_id, final_score, objective_score,
      row_number() over (order by final_score desc, objective_score desc, quiz_elapsed_ms asc nulls last, submitted_at asc) as place
    from scored
  ),
  -- Scale each declared placement_split_bps entry (sums to 10000, "100% of the prize pool")
  -- against v_pool_bps (the actual share_bps total settle_guild_event() requires), floored, so
  -- no rounding can ever push the total over v_pool_bps.
  awarded as (
    select r.place, r.entrant_id,
      (((elem->>'share_bps')::integer * v_pool_bps) / 10000) as raw_share_bps
    from ranked r
    join jsonb_array_elements(v_objective.placement_split_bps) elem
      on (elem->>'place')::integer = r.place
  ),
  final_shares as (
    -- The floor above can leave a few basis points short of v_pool_bps — settle_guild_event()
    -- requires an EXACT match, so the shortfall is added to 1st place (deterministic, declared
    -- up front in this comment, never a discretionary choice at settlement time).
    select place, entrant_id,
      raw_share_bps + case when place = (select min(place) from awarded)
        then v_pool_bps - (select coalesce(sum(raw_share_bps), 0) from awarded)
        else 0
      end as share_bps
    from awarded
  )
  select jsonb_agg(jsonb_build_object(
    'contributor_id', entrant_id, 'place', place, 'share_bps', share_bps
  ) order by place)
  into v_placements
  from final_shares
  where share_bps > 0;

  if v_placements is null or jsonb_array_length(v_placements) = 0 then
    raise exception 'No eligible entrant placed — nothing to settle.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (v_guild_id, p_event_id, v_placements, 'computed', null, now())
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'computed', submitted_by = null, submitted_at = now(),
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;

  -- Migration 168: an escrowed prize is paid automatically as soon as the placements are computed —
  -- winners no longer wait on a guild leader's approval click. The result is deterministic (computed
  -- on the server from locked rules), so there is nothing left for an approver to decide. (Migration 169: this now
  -- applies to judge-free events only, so judge exclusion + recompute stays possible on judged ones.)
  -- Migration 169: only a judge-free event (weight_bps = 10000: a draw, a quiz score, a bracket) is
  -- paid the moment it is computed. A judged event stays 'computed' so Inkroot can exclude a judge and
  -- recompute; it is paid by settle_computed_guild_event() below once Inkroot is satisfied.
  if v_escrowed and v_objective.weight_bps = 10000 then
    perform set_config('inkroot.auto_settle_event', p_event_id::text, true);
    perform settle_guild_event(
      v_guild_id, p_event_id,
      (select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
       from jsonb_array_elements(v_placements) p)
    );
    perform set_config('inkroot.auto_settle_event', '', true);
    update guild_event_results
      set status = 'approved', reviewed_by = null, reviewed_at = now(), settled_at = now()
      where event_id = p_event_id
      returning * into v_row;
  end if;
  return v_row;
end;
$$;

revoke all on function compute_guild_event_placements(uuid, uuid[]) from public;
grant execute on function compute_guild_event_placements(uuid, uuid[]) to authenticated;

-- 8. The generic submit RPC refuses a quiz event (migration 170's body plus one marked check).
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

-- 9. Public listing: migration 171's body plus the quiz fields (never the questions). Dropped first
--    because its return columns change.
drop function if exists list_public_guild_events(integer);
create function list_public_guild_events(p_result_limit integer default null)
returns table (
  id uuid, guild_id uuid, guild_name text, guild_crest_url text,
  host text, title text, description text, event_type text, cover_image_url text,
  entry_fee_kobo bigint, cash_prize_kobo bigint, participant_limit integer,
  start_date timestamptz, end_date timestamptz, approval_status text, status text,
  participant_count integer, collected_net_kobo bigint,
  rules text, guaranteed_prize_kobo bigint, min_word_count integer, max_word_count integer,
  draw_method text,
  quiz_source text, quiz_time_limit_seconds integer, quiz_question_count integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select
      e.id, e.guild_id, g.name, g.crest_url,
      e.host, e.title, e.description, e.event_type, e.cover_image_url,
      e.entry_fee_kobo, e.cash_prize_kobo, e.participant_limit,
      e.start_date, e.end_date, e.approval_status, e.status,
      (case when e.event_type = 'giveaway'
        then (select count(*) from guild_event_tickets t where t.event_id = e.id)
        else coalesce(c.participant_count, 0) end)::integer,
      coalesce(c.collected_net_kobo, 0)::bigint,
      e.rules, e.guaranteed_prize_kobo, e.min_word_count, e.max_word_count,
      e.draw_method,
      e.quiz_source, e.quiz_time_limit_seconds,
      (select count(*) from guild_quiz_questions q where q.event_id = e.id and q.status = 'approved')::integer
    from guild_events e
    join player_guilds g on g.id = e.guild_id
    left join lateral (
      select
        count(*) filter (where x.status = 'success')::integer as participant_count,
        sum(x.net_kobo) filter (where x.status = 'success')::bigint as collected_net_kobo
      from guild_event_entries x
      where x.event_id = e.id
    ) c on true
    where e.approval_status in ('published', 'active', 'completed')
    order by
      case e.approval_status when 'active' then 0 when 'published' then 1 else 2 end,
      coalesce(e.start_date, e.created_at) desc
    limit coalesce(p_result_limit, 30);
end;
$$;
revoke all on function list_public_guild_events(integer) from public;
grant execute on function list_public_guild_events(integer) to authenticated;
