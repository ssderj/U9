-- 184_migration_quiz_reviewers_cannot_play.sql
--
-- Nobody who can review a guild's quiz questions (its owner and its officers - migration 183) may enter
-- or play that guild's quiz or tournament, because reviewers can read the answer keys.
--
-- Entry was already closed to them: migration 169 bars every member, officer and owner of the hosting
-- guild from entering its events (create_guild_event_entry_locked), and that check is still the latest.
-- What 169 does NOT cover is a person who entered FIRST and became an officer (or joined the guild)
-- afterwards: the check only runs at entry time. This migration closes that gap on the play side and
-- adds a second, independent guard on the entry row itself:
--   * guild_quiz_is_reviewer(guild, user)   - true for the guild's owner or a member whose role is 'officer'.
--                                            Takes the user as an argument (183's guild_quiz_can_review()
--                                            only ever asks about the caller).
--   * guild_quiz_block_writer_entry()       - the entry-row trigger (174) also refuses a reviewer, for
--                                            quizzes and tournaments.
--   * start_guild_quiz_attempt()            - 174's body plus one check.
--   * start_tournament_match()              - 176's body plus one check.
-- Needs 183 (for the officer rule to match what can actually see keys). A treasurer is NOT a reviewer.
-- Not run against a live database. Safe to apply more than once (create-or-replace).

create or replace function guild_quiz_is_reviewer(p_guild_id uuid, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_user_id is not null and (
    exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = p_user_id)
    or exists (select 1 from player_guild_members m
               where m.guild_id = p_guild_id and m.user_id = p_user_id and m.role = 'officer')
  );
$$;
revoke all on function guild_quiz_is_reviewer(uuid, uuid) from public, anon, authenticated;

create or replace function guild_quiz_block_writer_entry()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if guild_quiz_user_wrote_for_event(new.event_id, new.entrant_id) then
    raise exception 'You wrote a question for this quiz, so you can''t enter it.';
  end if;
  select * into v_event from guild_events where id = new.event_id;
  if found and v_event.event_type in ('reading_challenge', 'tournament')
     and guild_quiz_is_reviewer(v_event.guild_id, new.entrant_id) then
    raise exception 'The guild owner and officers can''t enter this event.';
  end if;
  return new;
end;
$$;

-- start_guild_quiz_attempt
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
  -- Migration 184: whoever can review this guild's questions (owner, officer) sees the answer keys, so
  -- they can never play, even if they were promoted or joined after entering.
  if guild_quiz_is_reviewer(v_event.guild_id, auth.uid()) then
    raise exception 'The guild owner and officers can''t take this quiz.';
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

-- start_tournament_match
create or replace function start_tournament_match(p_match_id uuid)
returns table (
  started_at timestamptz, time_limit_seconds integer, question_count integer, questions jsonb, server_now timestamptz
)
language plpgsql security definer set search_path = public as $$
declare
  v_m guild_event_tournament_matches%rowtype;
  v_event guild_events%rowtype;
  v_side text;
  v_started timestamptz;
  v_submitted timestamptz;
  v_total integer;
  v_limit integer;
  v_now timestamptz;
  v_questions jsonb;
begin
  if auth.uid() is null then
    raise exception 'Sign in to play your match.';
  end if;
  if is_banned(auth.uid()) then
    raise exception 'This account can''t play in tournaments.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_tournament_match:' || p_match_id::text));
  select * into v_m from guild_event_tournament_matches mt where mt.id = p_match_id;
  if not found then
    raise exception 'Match not found.';
  end if;
  select * into v_event from guild_events e where e.id = v_m.event_id;
  if v_event.approval_status <> 'active' then
    raise exception 'This tournament isn''t running.';
  end if;
  if guild_quiz_user_wrote_for_event(v_m.event_id, auth.uid()) then
    raise exception 'You wrote a question for this tournament, so you can''t play in it.';
  end if;
  -- Migration 184: same rule as quizzes - reviewers see the answer keys, so they can't play.
  if guild_quiz_is_reviewer(v_event.guild_id, auth.uid()) then
    raise exception 'The guild owner and officers can''t play in this tournament.';
  end if;

  v_side := case when v_m.player_a = auth.uid() then 'a' when v_m.player_b = auth.uid() then 'b' else null end;
  if v_side is null then
    raise exception 'This isn''t your match.';
  end if;
  if v_m.is_bye or v_m.status <> 'open' then
    raise exception 'This match isn''t open for play.';
  end if;
  v_now := clock_timestamp();
  if v_now >= v_m.deadline_at then
    raise exception 'This round has ended.';
  end if;

  v_started := case when v_side = 'a' then v_m.a_started_at else v_m.b_started_at end;
  v_submitted := case when v_side = 'a' then v_m.a_submitted_at else v_m.b_submitted_at end;
  if v_submitted is not null then
    raise exception 'You''ve already played this match.';
  end if;

  select count(*)::integer into v_total from guild_event_tournament_match_questions mq where mq.match_id = p_match_id;
  if v_total = 0 then
    raise exception 'This match has no questions.';
  end if;
  v_limit := v_total * guild_tournament_seconds_per_question();

  if v_started is null then
    if v_m.deadline_at - v_now < interval '30 seconds' then
      raise exception 'This round is about to end — it''s too late to start.';
    end if;
    v_started := v_now;
    if v_side = 'a' then
      update guild_event_tournament_matches set a_started_at = v_started where id = p_match_id;
    else
      update guild_event_tournament_matches set b_started_at = v_started where id = p_match_id;
    end if;
  elsif v_now > v_started + make_interval(secs => v_limit + guild_quiz_grace_seconds()) then
    raise exception 'Your time for this match has run out.';
  end if;

  -- What the player really has: the allowance, but never past the round's deadline.
  v_limit := least(v_limit, greatest(0, floor(extract(epoch from (v_m.deadline_at - v_started)))::integer));

  -- Questions and options only. The key column is never selected here.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'prompt', q.prompt,
           'options', (select jsonb_agg(o.opt order by md5(auth.uid()::text || q.id::text || (o.opt ->> 'id')))
                       from jsonb_array_elements(q.options) as o(opt))
         ) order by mq.position), '[]'::jsonb)
  into v_questions
  from guild_event_tournament_match_questions mq
  join guild_quiz_questions q on q.id = mq.question_id
  where mq.match_id = p_match_id;

  return query select v_started, v_limit, v_total, v_questions, clock_timestamp();
end;
$$;

revoke all on function start_tournament_match(uuid) from public, anon;
grant execute on function start_tournament_match(uuid) to authenticated;
