-- 183_migration_quiz_review_owner_and_officer.sql
--
-- Who may review quiz questions in a Player Guild: the guild OWNER and its OFFICERS, and nobody else.
--
-- Before this, review was owner-only on the server (guild_officer_gate -> is_guild_officer, which is
-- just player_guilds.owner_id). The screen (guild-events-section.jsx) already showed the review
-- controls to treasurers and officers, so an officer or treasurer saw buttons the server then refused.
-- Now:
--   * guild_quiz_can_review(guild)  - true for the owner, or a member whose role is 'officer'.
--     A 'treasurer' is deliberately NOT included: that role is for money, not for question review.
--   * guild_quiz_review_gate(guild, message) - the same 'Guild not found.' / message pair
--     guild_officer_gate gives, using the check above.
-- Four functions swap the owner-only gate for it; nothing else in them changes (bodies are 174's and,
-- for edit_guild_quiz_question, 179's):
--   review_guild_quiz_question          approve / reject a suggestion
--   list_guild_bank_questions           the bank, keys included, so a reviewer can see what they approve
--   list_guild_quiz_questions_for_host  an event's pool + waiting suggestions, keys included
--   edit_guild_quiz_question            a reviewer may fix a question (it returns to 'pending')
-- Not changed on purpose: setting up a quiz, choosing its pool, adding questions directly, removing
-- questions, payouts - all still owner-only. Members' keys stay unreadable: this only widens who counts
-- as a reviewer. Inkroot official questions are unaffected (179's admin rules).
-- Not run against a live database. Safe to apply more than once (create-or-replace).

create or replace function guild_quiz_can_review(p_guild_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    is_guild_officer(p_guild_id)
    or coalesce((select m.role from player_guild_members m
                 where m.guild_id = p_guild_id and m.user_id = auth.uid()) = 'officer', false)
  );
$$;
revoke all on function guild_quiz_can_review(uuid) from public, anon, authenticated;

create or replace function guild_quiz_review_gate(p_guild_id uuid, p_denied_message text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from player_guilds where id = p_guild_id) then
    raise exception 'Guild not found.';
  end if;
  if not guild_quiz_can_review(p_guild_id) then
    raise exception '%', p_denied_message;
  end if;
end;
$$;
revoke all on function guild_quiz_review_gate(uuid, text) from public, anon, authenticated;

-- review_guild_quiz_question
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
  perform guild_quiz_review_gate(v_q.guild_id, 'Only the guild owner or an officer can review suggested questions.');
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

-- list_guild_bank_questions
create or replace function list_guild_bank_questions(
  p_guild_id uuid, p_anthology_id uuid default null, p_general_only boolean default false
)
returns table (
  id uuid, anthology_id uuid, author_id uuid, origin text, status text, prompt text, options jsonb,
  correct_option_id text, times_used integer, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  perform guild_quiz_review_gate(p_guild_id, 'Only the guild owner or an officer can see the question bank.');
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

-- list_guild_quiz_questions_for_host
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
  perform guild_quiz_review_gate(v_event.guild_id, 'Only the guild owner or an officer can see the question bank.');
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

-- edit_guild_quiz_question
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
  if not (coalesce(v_q.author_id = auth.uid(), false) or guild_quiz_can_review(v_q.guild_id)) then
    raise exception 'Only the writer, the guild owner or an officer can edit this question.';
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
