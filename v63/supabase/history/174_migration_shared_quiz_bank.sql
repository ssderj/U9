-- 174_migration_shared_quiz_bank.sql
--
-- From per-event questions to a SHARED QUESTION BANK (the design in the backend spec, section 2 / 2a).
--
-- Migration 172 stored every question against one event, so a guild rewrote its questions for each
-- quiz and a tournament would have had nothing to draw from. Now a guild has ONE bank:
--
--   * A question belongs to the GUILD, and to one of its anthologies (a "book bank") or to no
--     anthology at all (the guild's general trivia bank). guild_quiz_questions keeps its columns
--     and gains guild_id + anthology_id; event_id stays only as "the event this was suggested for"
--     and is now nullable, so a question outlives the event it was written for.
--   * An EVENT uses a subset of the bank, its POOL (guild_event_quiz_pool). The pool is chosen by
--     the host while the event is still being set up and is FROZEN the moment it opens — the same
--     "locked once open" rule 172 already had, so nothing about grading or fairness changes.
--   * Approved questions can be reused by any later quiz (and, in the next migration, by
--     tournaments) on the same bank. Anyone in the guild can suggest one at any time.
--
-- THE FAIRNESS RULE, as the app owner decided: nobody who wrote a question that is in an event's
-- pool can enter (or take) that event, and members of the hosting guild can never enter their own
-- guild's events (migration 169 — unchanged, and it is why the second rule below rarely bites:
-- only guild members can write guild questions). The author rule is now judged against the POOL,
-- not the bank: writing a question for the bank does not lock you out of every quiz, only out of
-- the ones whose frozen pool actually contains your question. guild_quiz_user_wrote_for_event()
-- is the one place that rule lives, so the tournament entry can call the same check.
--
-- What did NOT change: answer keys are still unreadable by any client (RLS on, no policies; keys
-- only leave through the security-definer functions); grading, the server clock, one attempt per
-- entrant, ranking (compute_guild_event_placements) and payouts are exactly 172's.
--
-- Behaviour changes to know about:
--   * A member may have 10 suggestions waiting at a time (was 3 per quiz) — the spec's figure, now
--     counted across the guild's whole bank. A quiz's pool is still capped at 30 questions.
--   * Suggestions still waiting when an event opens are no longer rejected — they stay in the
--     bank for next time; only the pool is frozen.
--   * remove_guild_quiz_question() now deletes the question from the BANK (refused if a running or
--     finished event uses it). To take one out of just one event, use detach_guild_quiz_question().
--   * Editing an approved question sends it back to 'pending' and pulls it out of any event that
--     hasn't opened yet. A question already used by an open or finished event can't be edited.
--   * The existing event-scoped functions (host_add / suggest / list) keep their names and
--     arguments, so the current quiz screens keep working; they now read and write the bank.
--
-- Not built here (screens come later): Inkroot-wide official banks, and "credit" lines under
-- results. Not run against a live database. Safe to apply once; existing 172 questions are copied
-- into the bank and every approved one is placed in its event's pool, so running quizzes score
-- exactly as before. Known edge: deleting an anthology deletes the questions written for it.

-- 1. Schema ------------------------------------------------------------------------------------
alter table guild_quiz_questions
  add column if not exists guild_id uuid references player_guilds(id) on delete cascade,
  add column if not exists anthology_id uuid references guild_anthologies(id) on delete cascade;

update guild_quiz_questions q
   set guild_id = e.guild_id,
       anthology_id = case when e.quiz_source = 'anthology' then e.quiz_anthology_id else null end
  from guild_events e
 where e.id = q.event_id and q.guild_id is null;

alter table guild_quiz_questions alter column guild_id set not null;

-- A question now outlives the event it was written for.
alter table guild_quiz_questions alter column event_id drop not null;
alter table guild_quiz_questions drop constraint if exists guild_quiz_questions_event_id_fkey;
alter table guild_quiz_questions
  add constraint guild_quiz_questions_event_id_fkey
  foreign key (event_id) references guild_events(id) on delete set null;

create index if not exists guild_quiz_questions_bank_idx on guild_quiz_questions (guild_id, anthology_id, status);

create table if not exists guild_event_quiz_pool (
  event_id uuid not null references guild_events(id) on delete cascade,
  question_id uuid not null references guild_quiz_questions(id) on delete cascade,
  sort_order integer not null default 0,
  added_at timestamptz not null default now(),
  primary key (event_id, question_id)
);
alter table guild_event_quiz_pool enable row level security;
-- No policies: nothing here is readable or writable by a client.
create index if not exists guild_event_quiz_pool_question_idx on guild_event_quiz_pool (question_id);

-- Every approved 172 question goes into the pool of the event it was written for.
insert into guild_event_quiz_pool (event_id, question_id, sort_order)
select q.event_id, q.id, q.sort_order
from guild_quiz_questions q
where q.event_id is not null and q.status = 'approved'
on conflict do nothing;

-- 2. Constants and helpers ---------------------------------------------------------------------
-- Suggestions a member can have waiting at a time, across the guild's whole bank.
create or replace function guild_quiz_member_suggestion_cap() returns integer as $$ select 10; $$ language sql immutable;

-- The anthology an event's bank is tied to: its anthology for a book quiz, null for general trivia.
create or replace function guild_quiz_event_anthology(p_event guild_events)
returns uuid
language sql immutable as $$
  select case when p_event.quiz_source = 'anthology' then p_event.quiz_anthology_id else null end;
$$;
revoke all on function guild_quiz_event_anthology(guild_events) from public, anon, authenticated;

-- THE fairness rule: did this person write any question in this event's pool? Used by the quiz
-- entry/attempt below and reusable by the tournament entry.
create or replace function guild_quiz_user_wrote_for_event(p_event_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from guild_event_quiz_pool p
    join guild_quiz_questions q on q.id = p.question_id
    where p.event_id = p_event_id and q.author_id = p_user_id
  );
$$;
revoke all on function guild_quiz_user_wrote_for_event(uuid, uuid) from public, anon, authenticated;

-- The single place a question is put into an event's pool. Strict = raise a plain-language error
-- (host actions); not strict = quietly return false (an approval that tries to auto-add).
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
    when v_event.host <> 'guild' or v_event.event_type <> 'reading_challenge' then 'Questions only apply to a Reading & Trivia event.'
    when not guild_quiz_questions_editable(v_event.approval_status) then 'The questions are locked once the event is with Inkroot or open.'
    when v_event.quiz_source is null then 'Choose the quiz''s book (or no book) before adding questions.'
    when v_q.guild_id <> v_event.guild_id or v_q.anthology_id is distinct from guild_quiz_event_anthology(v_event)
      then 'That question belongs to a different question bank.'
    when v_q.status <> 'approved' then 'Only approved questions can go into a quiz.'
    when v_q.author_id is not null and exists (
      select 1 from guild_event_entries where event_id = p_event_id and entrant_id = v_q.author_id
    ) then 'The writer of that question has already entered this quiz.'
    when (select count(*) from guild_event_quiz_pool where event_id = p_event_id) >= guild_quiz_question_cap()
      then format('A quiz can have at most %s questions.', guild_quiz_question_cap())
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

-- 3. Fairness: writers of a pool question can't enter or take that quiz ------------------------
create or replace function guild_quiz_block_writer_entry()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if guild_quiz_user_wrote_for_event(new.event_id, new.entrant_id) then
    raise exception 'You wrote a question for this quiz, so you can''t enter it.';
  end if;
  return new;
end;
$$;
-- (the trigger from migration 172 already points at this function name)

-- Opening gate: settings + enough approved questions IN THE POOL. The pool is frozen from here
-- (every pool edit checks the event is still editable). Pending bank suggestions are left alone.
create or replace function guild_quiz_activation_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_in_pool integer;
begin
  if new.host = 'guild' and new.event_type = 'reading_challenge'
     and new.approval_status = 'active' and old.approval_status is distinct from 'active' then
    if new.quiz_time_limit_seconds is null or new.quiz_source is null
       or (new.quiz_source = 'anthology' and new.quiz_anthology_id is null) then
      raise exception 'Set up this quiz (source and time limit) before opening it.';
    end if;
    select count(*) into v_in_pool
    from guild_event_quiz_pool p
    join guild_quiz_questions q on q.id = p.question_id
    where p.event_id = new.id and q.status = 'approved';
    if v_in_pool < guild_quiz_min_questions() then
      raise exception 'A quiz needs at least % approved questions to open (this one has %).', guild_quiz_min_questions(), v_in_pool;
    end if;
  end if;
  return new;
end;
$$;

-- 4. Host: settings and this event's questions -------------------------------------------------
-- 172's body, plus: choosing a different book (or none) empties the pool, because the pool must
-- come from the same bank as the event.
create or replace function set_guild_quiz_settings(
  p_event_id uuid, p_source text, p_anthology_id uuid, p_time_limit_seconds integer
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_old_bank uuid;
  v_new_bank uuid;
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

  v_old_bank := guild_quiz_event_anthology(v_event);
  v_new_bank := case when p_source = 'anthology' then p_anthology_id else null end;
  if v_event.quiz_source is not null and v_old_bank is distinct from v_new_bank then
    delete from guild_event_quiz_pool where event_id = p_event_id;
  end if;

  update guild_events
    set quiz_source = p_source,
        quiz_anthology_id = v_new_bank,
        quiz_time_limit_seconds = p_time_limit_seconds
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function set_guild_quiz_settings(uuid, text, uuid, integer) from public, anon;
grant execute on function set_guild_quiz_settings(uuid, text, uuid, integer) to authenticated;

-- The host writes a question: it goes into the guild's bank (approved at once) AND into this pool.
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
  if v_event.quiz_source is null then
    raise exception 'Choose the quiz''s book (or no book) before adding questions.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  insert into guild_quiz_questions (event_id, guild_id, anthology_id, author_id, origin, status, prompt, options,
                                    correct_option_id, reviewed_by, reviewed_at)
  values (p_event_id, v_event.guild_id, guild_quiz_event_anthology(v_event), auth.uid(), 'host', 'approved',
          trim(p_prompt), v_options, trim(p_correct_option_id), auth.uid(), now())
  returning id into v_id;

  -- Strict: if the pool is full (or otherwise refuses), the whole call fails and nothing is saved.
  perform guild_quiz_attach_to_pool(p_event_id, v_id, true);
  return v_id;
end;
$$;
revoke all on function host_add_guild_quiz_question(uuid, text, jsonb, text) from public, anon;
grant execute on function host_add_guild_quiz_question(uuid, text, jsonb, text) to authenticated;

-- Put existing approved bank questions into this event's pool (host, before the event opens).
create or replace function attach_guild_quiz_questions(p_event_id uuid, p_question_ids uuid[])
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_id uuid;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can choose the questions.');
  if p_question_ids is null or coalesce(array_length(p_question_ids, 1), 0) = 0 then
    raise exception 'Choose at least one question.';
  end if;
  foreach v_id in array p_question_ids loop
    perform guild_quiz_attach_to_pool(p_event_id, v_id, true);
  end loop;
  return (select count(*)::integer from guild_event_quiz_pool where event_id = p_event_id);
end;
$$;
revoke all on function attach_guild_quiz_questions(uuid, uuid[]) from public, anon;
grant execute on function attach_guild_quiz_questions(uuid, uuid[]) to authenticated;

-- Take a question out of ONE event's pool; it stays in the bank.
create or replace function detach_guild_quiz_question(p_event_id uuid, p_question_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can choose the questions.');
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'The questions are locked once the event is with Inkroot or open.';
  end if;
  delete from guild_event_quiz_pool where event_id = p_event_id and question_id = p_question_id;
end;
$$;
revoke all on function detach_guild_quiz_question(uuid, uuid) from public, anon;
grant execute on function detach_guild_quiz_question(uuid, uuid) to authenticated;

-- Delete a question from the bank. Refused while an open or finished event uses it.
create or replace function remove_guild_quiz_question(p_question_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
begin
  select * into v_q from guild_quiz_questions where id = p_question_id;
  if not found then
    raise exception 'Question not found.';
  end if;
  perform guild_officer_gate(v_q.guild_id, 'Only the guild owner can remove questions.');
  if exists (
    select 1 from guild_event_quiz_pool p
    join guild_events e on e.id = p.event_id
    where p.question_id = p_question_id and not guild_quiz_questions_editable(e.approval_status)
  ) then
    raise exception 'This question is used by an event that is open or finished, so it can''t be removed.';
  end if;
  delete from guild_quiz_questions where id = p_question_id;
end;
$$;
revoke all on function remove_guild_quiz_question(uuid) from public, anon;
grant execute on function remove_guild_quiz_question(uuid) to authenticated;

-- Approve or reject a suggestion. The bank is permanent, so this works at any time; an approved
-- question is also put into the pool of the event it was suggested for, if that event is still
-- being set up and has room.
create or replace function review_guild_quiz_question(p_question_id uuid, p_approve boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_q guild_quiz_questions%rowtype;
begin
  select * into v_q from guild_quiz_questions where id = p_question_id for update;
  if not found then
    raise exception 'Question not found.';
  end if;
  perform guild_officer_gate(v_q.guild_id, 'Only the guild owner can review suggested questions.');
  if v_q.status <> 'pending' then
    raise exception 'This suggestion has already been reviewed.';
  end if;
  update guild_quiz_questions
    set status = case when coalesce(p_approve, false) then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_question_id;

  if coalesce(p_approve, false) and v_q.event_id is not null then
    perform guild_quiz_attach_to_pool(v_q.event_id, p_question_id, false);
  end if;
end;
$$;
revoke all on function review_guild_quiz_question(uuid, boolean) from public, anon;
grant execute on function review_guild_quiz_question(uuid, boolean) to authenticated;

-- Change a question. Approved -> pending again (a reviewer must re-approve), and it leaves any
-- event that hasn't opened yet. A question used by an open or finished event can't be edited.
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

-- What the host's event screen shows: this event's pool, plus the bank's waiting suggestions and
-- this event's own rejected ones. Keys included — officers only. (Dropped first: new column.)
drop function if exists list_guild_quiz_questions_for_host(uuid);
create function list_guild_quiz_questions_for_host(p_event_id uuid)
returns table (
  id uuid, author_id uuid, origin text, status text, prompt text, options jsonb,
  correct_option_id text, sort_order integer, created_at timestamptz, in_pool boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  select * into v_event from guild_events e where e.id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can see the question bank.');
  return query
    select q.id, q.author_id, q.origin, q.status, q.prompt, q.options, q.correct_option_id,
           coalesce(p.sort_order, q.sort_order), q.created_at, (p.question_id is not null)
    from guild_quiz_questions q
    left join guild_event_quiz_pool p on p.question_id = q.id and p.event_id = p_event_id
    where q.guild_id = v_event.guild_id
      and q.anthology_id is not distinct from guild_quiz_event_anthology(v_event)
      and (p.question_id is not null or q.status = 'pending' or (q.status = 'rejected' and q.event_id = p_event_id))
    order by case when q.status = 'pending' then 0 when p.question_id is not null then 1 else 2 end,
             coalesce(p.sort_order, q.sort_order), q.created_at;
end;
$$;
revoke all on function list_guild_quiz_questions_for_host(uuid) from public, anon;
grant execute on function list_guild_quiz_questions_for_host(uuid) to authenticated;

-- 5. Members: suggest to the bank --------------------------------------------------------------
-- Event-scoped entry point kept for the current screen: suggests into the bank this event uses,
-- remembering the event so an approval can drop it straight into the pool.
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
  if v_event.quiz_source is null then
    raise exception 'The host hasn''t chosen the quiz''s book yet.';
  end if;
  if exists (select 1 from guild_event_entries where event_id = p_event_id and entrant_id = auth.uid()) then
    raise exception 'You''ve entered this quiz, so you can''t write for it.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

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

-- Suggest straight to the guild's bank, with no event in mind (the "+ Add a question" button).
-- p_anthology_id null = the guild's general trivia bank.
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

-- An officer writes straight into the bank (approved at once).
create or replace function host_add_guild_bank_question(
  p_guild_id uuid, p_anthology_id uuid, p_prompt text, p_options jsonb, p_correct_option_id text
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_options jsonb;
  v_id uuid;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can add questions to the bank.');
  if p_anthology_id is not null and not exists (
    select 1 from guild_anthologies a where a.id = p_anthology_id and a.guild_id = p_guild_id
  ) then
    raise exception 'Choose one of this guild''s own anthologies.';
  end if;
  if p_prompt is null or char_length(trim(p_prompt)) < 3 or char_length(trim(p_prompt)) > 500 then
    raise exception 'A question needs between 3 and 500 characters.';
  end if;
  v_options := guild_quiz_clean_options(p_options, p_correct_option_id);

  insert into guild_quiz_questions (event_id, guild_id, anthology_id, author_id, origin, status, prompt, options,
                                    correct_option_id, reviewed_by, reviewed_at)
  values (null, p_guild_id, p_anthology_id, auth.uid(), 'host', 'approved', trim(p_prompt), v_options,
          trim(p_correct_option_id), auth.uid(), now())
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function host_add_guild_bank_question(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function host_add_guild_bank_question(uuid, uuid, text, jsonb, text) to authenticated;

-- A writer's own suggestions for the bank this event uses (they wrote the key, so it comes back).
create or replace function list_my_guild_quiz_suggestions(p_event_id uuid)
returns table (
  id uuid, status text, prompt text, options jsonb, correct_option_id text, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select q.id, q.status, q.prompt, q.options, q.correct_option_id, q.created_at
  from guild_quiz_questions q
  join guild_events e on e.id = p_event_id
  where q.guild_id = e.guild_id
    and q.anthology_id is not distinct from guild_quiz_event_anthology(e)
    and q.author_id = auth.uid() and q.origin = 'member'
  order by q.created_at;
$$;
revoke all on function list_my_guild_quiz_suggestions(uuid) from public, anon;
grant execute on function list_my_guild_quiz_suggestions(uuid) to authenticated;

-- Everything a member has written for a guild, across all its banks, any status.
create or replace function list_my_guild_bank_questions(p_guild_id uuid)
returns table (
  id uuid, anthology_id uuid, status text, prompt text, options jsonb, correct_option_id text, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select q.id, q.anthology_id, q.status, q.prompt, q.options, q.correct_option_id, q.created_at
  from guild_quiz_questions q
  where q.guild_id = p_guild_id and q.author_id = auth.uid() and q.origin = 'member'
  order by q.created_at;
$$;
revoke all on function list_my_guild_bank_questions(uuid) from public, anon;
grant execute on function list_my_guild_bank_questions(uuid) to authenticated;

-- The whole bank for officers, keys included. p_general_only = just the no-anthology trivia bank;
-- otherwise p_anthology_id narrows to one anthology, and null means every bank.
create or replace function list_guild_bank_questions(
  p_guild_id uuid, p_anthology_id uuid default null, p_general_only boolean default false
)
returns table (
  id uuid, anthology_id uuid, author_id uuid, origin text, status text, prompt text, options jsonb,
  correct_option_id text, times_used integer, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can see the question bank.');
  return query
    select q.id, q.anthology_id, q.author_id, q.origin, q.status, q.prompt, q.options, q.correct_option_id,
           (select count(*)::integer from guild_event_quiz_pool p where p.question_id = q.id),
           q.created_at
    from guild_quiz_questions q
    where q.guild_id = p_guild_id
      and case when p_general_only then q.anthology_id is null
               when p_anthology_id is not null then q.anthology_id = p_anthology_id
               else true end
    order by case q.status when 'pending' then 0 when 'approved' then 1 else 2 end, q.created_at;
end;
$$;
revoke all on function list_guild_bank_questions(uuid, uuid, boolean) from public, anon;
grant execute on function list_guild_bank_questions(uuid, uuid, boolean) to authenticated;

-- "12 questions ready" — counts only, for any guild member. Never the questions themselves.
create or replace function get_guild_bank_counts(
  p_guild_id uuid, p_anthology_id uuid default null, p_general_only boolean default false
)
returns table (approved_count integer, pending_count integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not (is_guild_member(p_guild_id) or is_guild_officer(p_guild_id)) then
    raise exception 'Only members of this guild can see its question bank.';
  end if;
  return query
    select (count(*) filter (where q.status = 'approved'))::integer,
           (count(*) filter (where q.status = 'pending'))::integer
    from guild_quiz_questions q
    where q.guild_id = p_guild_id
      and case when p_general_only then q.anthology_id is null
               when p_anthology_id is not null then q.anthology_id = p_anthology_id
               else true end;
end;
$$;
revoke all on function get_guild_bank_counts(uuid, uuid, boolean) from public, anon;
grant execute on function get_guild_bank_counts(uuid, uuid, boolean) to authenticated;

-- 6. Entrants: start and submit now read the POOL ----------------------------------------------
-- Migration 172's bodies with two changes, both marked: the "writer can't take it" check uses the
-- pool rule, and the questions come from the event's pool.
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
  -- Migration 174: judged against the frozen pool, not the whole bank.
  if guild_quiz_user_wrote_for_event(p_event_id, auth.uid()) then
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

  -- Questions and options only. The key column is never selected here. (Migration 174: from the pool.)
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options', q.options)
           order by p.sort_order, q.created_at), '[]'::jsonb), count(*)::integer
  into v_questions, v_count
  from guild_event_quiz_pool p
  join guild_quiz_questions q on q.id = p.question_id
  where p.event_id = p_event_id and q.status = 'approved';

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

  -- Migration 174: graded against the event's pool.
  select count(*) filter (where p_answers ->> q.id::text = q.correct_option_id), count(*)
  into v_score, v_total
  from guild_event_quiz_pool p
  join guild_quiz_questions q on q.id = p.question_id
  where p.event_id = p_event_id and q.status = 'approved';

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

-- 7. Public listing: 172's body, with the question count now read from the pool ---------------
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
      (select count(*) from guild_event_quiz_pool p
         join guild_quiz_questions q on q.id = p.question_id
        where p.event_id = e.id and q.status = 'approved')::integer
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
