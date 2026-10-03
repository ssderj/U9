-- ============================================================================================
-- Test for the quiz grader and the tournament engine
--   172/174  submit_guild_quiz_attempt()  (graded against the event's frozen pool)
--   185      official_event_placements()  (quiz ranking: score %, fastest time, who finished first)
--   176      guild_tournament_build_bracket() / _resolve_match() / _advance() / _resolve_event()
--
-- How to run: SCRATCH or DEV database only (never production) with supabase/schema.sql applied through
-- migration 187, as a role that bypasses RLS (postgres), in the SQL editor or `psql -f`. Everything runs in
-- ONE transaction that ROLLS BACK. A failing case raises 'FAIL (...)' and aborts; a clean run ends with
-- 'PASS: ...' notices. It inserts (then rolls back) auth.users rows, so it is not safe on a live database.
--
-- NOTE: written without a database to run it against. Seeding follows what admin_create_official_event()
-- (185) inserts, using an Inkroot-hosted event with free entries so no Paystack columns are needed. If an
-- insert below trips a NOT NULL / check added by a later migration, add the missing column to that insert.
-- The tournament tests use random() inside the engine (shuffles, byes, coin-flip ties), so the checks
-- assert properties that must hold for every draw, and the size/bye cases run several times.
--
-- Cases
--  QUIZ GRADING (submit_guild_quiz_attempt)
--   Q1  10 in the pool, 7 right                       -> score 7, total 10
--   Q2  pending question in the pool + approved question outside it never count
--   Q3  wrong / missing / unknown answer keys count as wrong; extra keys are ignored
--   Q4  submitting twice                              -> refused
--   Q5  submitting without starting                   -> refused
--   Q6  inside the 5 s grace                          -> accepted, elapsed capped at the time limit
--   Q7  past time limit + grace                       -> refused
--   Q8  after the event has results                   -> refused
--  QUIZ RANKING (official_event_placements)
--   R1  score % first, then faster time, then who submitted first; shares follow the split
--   R2  nobody submitted                              -> refused
--  BRACKET (guild_tournament_build_bracket)
--   B1  sizes / rounds / byes for 2, 3, 4, 5, 6, 8 entrants (each run 5 times)
--   B2  every entrant appears exactly once in round 1; byes are alone in their match; real matches draw 10
--       questions; later rounds are 'waiting'
--   B3  9 entrants in a 3-round tournament, 1 entrant, a second build   -> refused
--  MATCH RESOLUTION (guild_tournament_resolve_match)
--   M1  before the deadline                           -> stays open
--   M2  higher score wins ('score')
--   M3  equal score, faster time wins ('time')
--   M4  equal score and time                          -> 'random', winner is one of the two
--   M5  only one submitted                            -> 'walkover' (either side)
--   M6  started but never submitted counts as not played
--   M7  neither played                                -> nobody wins ('none')
--  ADVANCING AND THE PODIUM (guild_tournament_resolve_event / _advance)
--   A1  4 players: round 2 opens with the two winners and its own 10 questions; final gives champion,
--       runner-up (played) and third (better semifinal loser who played); event completes, unpaid
--   A2  everybody no-shows                            -> 'no_contest', event completes
--   A3  3 players (one bye) with the other match a no-show -> the bye player is champion, no runner-up/third
--   A4  2 players, only one played                    -> champion by walkover, no runner-up, no third
--   A5  2 players, both played                        -> runner-up is the loser
--   A6  4 players, a semifinal loser who never played does not get third
-- ============================================================================================

begin;

create function pg_temp.act_as_user(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

create function pg_temp.act_as_none() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- n approved official-bank questions, all with correct answer 'a', added to the event's pool.
create function pg_temp.mk_pool(p_event uuid, p_n integer) returns uuid[] language plpgsql as $$
declare v_ids uuid[] := '{}'; v_id uuid; i integer;
begin
  for i in 1..p_n loop
    insert into guild_quiz_questions (scope, origin, status, prompt, options, correct_option_id)
    values ('inkroot', 'host', 'approved', 'Test question ' || i,
            '[{"id":"a","text":"Right"},{"id":"b","text":"Wrong"}]'::jsonb, 'a')
    returning id into v_id;
    insert into guild_event_quiz_pool (event_id, question_id, sort_order) values (p_event, v_id, i);
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end;
$$;

-- An open, official (Inkroot-hosted) event with p_n free entrants. kind = 'quiz' or 'tournament'.
-- Returns the event id; the entrants are the event's guild_event_entries rows.
create function pg_temp.mk_event(p_kind text, p_n integer, p_rounds integer default 4, p_pool integer default 15)
returns uuid language plpgsql as $$
declare ev uuid := gen_random_uuid(); u uuid; i integer;
begin
  insert into guild_events (id, guild_id, host, title, event_type, cash_prize_kobo, entry_fee_kobo,
                            quiz_time_limit_seconds, start_date, end_date, approval_status, status)
  values (ev, inkroot_official_guild_id(), 'inkroot', 'Test ' || p_kind || ' ' || ev::text,
          case when p_kind = 'quiz' then 'reading_challenge' else 'tournament' end,
          100000, null,
          case when p_kind = 'quiz' then 600 else null end,
          now(), now() + interval '1 day', 'active', 'open');
  if p_kind = 'tournament' then
    insert into guild_event_tournaments (event_id, rounds, source) values (ev, p_rounds, 'none');
  end if;
  perform pg_temp.mk_pool(ev, p_pool);
  for i in 1..p_n loop
    u := gen_random_uuid();
    insert into auth.users (id) values (u);
    insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, paid_at)
    values (ev, u, 'free_entry_' || gen_random_uuid()::text, 0, 0, 'success', now());
  end loop;
  return ev;
end;
$$;

-- Makes every open match of an event past its deadline (the resolver only touches those).
create function pg_temp.expire_open(p_event uuid) returns void language sql as $$
  update guild_event_tournament_matches set deadline_at = now() - interval '1 minute'
  where event_id = p_event and status = 'open';
$$;

-- Sets one side's finished attempt on a match.
create function pg_temp.play(p_match uuid, p_side text, p_score integer, p_elapsed integer) returns void language plpgsql as $$
begin
  if p_side = 'a' then
    update guild_event_tournament_matches
      set a_started_at = now() - interval '5 minutes', a_submitted_at = now() - interval '4 minutes',
          a_score = p_score, a_elapsed_ms = p_elapsed, a_tab_switches = 0
    where id = p_match;
  else
    update guild_event_tournament_matches
      set b_started_at = now() - interval '5 minutes', b_submitted_at = now() - interval '4 minutes',
          b_score = p_score, b_elapsed_ms = p_elapsed, b_tab_switches = 0
    where id = p_match;
  end if;
end;
$$;

do $$
declare
  ev uuid; ev2 uuid; m uuid; m1 uuid; m2 uuid; fin uuid;
  u1 uuid; u2 uuid; u3 uuid; u4 uuid;
  qids uuid[]; extra_a uuid; pending_q uuid;
  ans jsonb; r record; msg text; n integer; k integer; run integer;
  t guild_event_tournaments%rowtype; mt guild_event_tournament_matches%rowtype;
  v_size integer; v_rounds integer; v_byes integer;
  exp_sizes integer[] := array[2, 4, 4, 8, 8, 8];
  exp_rounds integer[] := array[1, 2, 2, 3, 3, 3];
  exp_byes integer[] := array[0, 1, 0, 3, 2, 0];
  ns integer[] := array[2, 3, 4, 5, 6, 8];
  pl jsonb; q_total integer;
begin
  -- ==========================================================================================
  -- QUIZ GRADING
  -- ==========================================================================================
  ev := pg_temp.mk_event('quiz', 0, 4, 10);
  select array_agg(question_id order by sort_order) into qids from guild_event_quiz_pool where event_id = ev;

  -- A pending question that IS in the pool, and an approved question that is NOT.
  insert into guild_quiz_questions (scope, origin, status, prompt, options, correct_option_id)
  values ('inkroot', 'host', 'pending', 'Pending one', '[{"id":"a","text":"x"},{"id":"b","text":"y"}]'::jsonb, 'a')
  returning id into pending_q;
  insert into guild_event_quiz_pool (event_id, question_id, sort_order) values (ev, pending_q, 99);
  insert into guild_quiz_questions (scope, origin, status, prompt, options, correct_option_id)
  values ('inkroot', 'host', 'approved', 'Outside the pool', '[{"id":"a","text":"x"},{"id":"b","text":"y"}]'::jsonb, 'a')
  returning id into extra_a;

  u1 := gen_random_uuid(); u2 := gen_random_uuid(); u3 := gen_random_uuid(); u4 := gen_random_uuid();
  insert into auth.users (id) values (u1), (u2), (u3), (u4);

  -- Q1 + Q2: 7 right of the 10 approved pool questions; the pending pool question and the outside question do not count.
  ans := '{}'::jsonb;
  for k in 1..10 loop
    ans := ans || jsonb_build_object(qids[k]::text, case when k <= 7 then 'a' else 'b' end);
  end loop;
  ans := ans || jsonb_build_object(pending_q::text, 'a', extra_a::text, 'a');   -- both must be ignored
  insert into guild_quiz_attempts (event_id, user_id, started_at) values (ev, u1, now() - interval '60 seconds');
  perform pg_temp.act_as_user(u1);
  select * into r from submit_guild_quiz_attempt(ev, ans);
  if r.score <> 7 or r.total <> 10 then
    raise exception 'FAIL (Q1/Q2): expected 7 of 10, got % of %', r.score, r.total;
  end if;
  if r.elapsed_ms < 55000 or r.elapsed_ms > 90000 then
    raise exception 'FAIL (Q1): elapsed_ms % should be about 60000', r.elapsed_ms;
  end if;

  -- Q3: wrong, missing and unknown keys are wrong; an extra key changes nothing. 3 right, 2 wrong, 5 missing, plus junk.
  ans := jsonb_build_object(qids[1]::text, 'a', qids[2]::text, 'a', qids[3]::text, 'a',
                            qids[4]::text, 'b', qids[5]::text, 'zzz',
                            gen_random_uuid()::text, 'a', 'not-a-uuid', 'a');
  insert into guild_quiz_attempts (event_id, user_id, started_at) values (ev, u2, now() - interval '30 seconds');
  perform pg_temp.act_as_user(u2);
  select * into r from submit_guild_quiz_attempt(ev, ans);
  if r.score <> 3 or r.total <> 10 then
    raise exception 'FAIL (Q3): expected 3 of 10, got % of %', r.score, r.total;
  end if;

  -- Q4: a second submit is refused and the stored score is unchanged.
  begin
    perform submit_guild_quiz_attempt(ev, jsonb_build_object(qids[1]::text, 'a'));
    raise exception 'FAIL (Q4): a second submit was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%already submitted%' then raise exception 'FAIL (Q4): unexpected error: %', msg; end if;
  end;
  if (select score from guild_quiz_attempts where event_id = ev and user_id = u2) <> 3 then
    raise exception 'FAIL (Q4): stored score changed after the refused second submit';
  end if;

  -- Q5: never started.
  perform pg_temp.act_as_user(u3);
  begin
    perform submit_guild_quiz_attempt(ev, '{}'::jsonb);
    raise exception 'FAIL (Q5): submit without starting was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%Start the quiz before submitting%' then raise exception 'FAIL (Q5): unexpected error: %', msg; end if;
  end;

  -- Q6: 603 s after starting (limit 600 s + 5 s grace) is accepted, and the recorded time is capped at 600 s.
  insert into guild_quiz_attempts (event_id, user_id, started_at) values (ev, u3, now() - interval '603 seconds');
  select * into r from submit_guild_quiz_attempt(ev, '{}'::jsonb);
  if r.elapsed_ms <> 600000 then
    raise exception 'FAIL (Q6): elapsed should be capped at 600000, got %', r.elapsed_ms;
  end if;
  if r.score <> 0 then raise exception 'FAIL (Q6): empty answers should score 0, got %', r.score; end if;

  -- Q7: 700 s after starting is past the grace window.
  insert into guild_quiz_attempts (event_id, user_id, started_at) values (ev, u4, now() - interval '700 seconds');
  perform pg_temp.act_as_user(u4);
  begin
    perform submit_guild_quiz_attempt(ev, '{}'::jsonb);
    raise exception 'FAIL (Q7): a late submit was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%Time''s up%' then raise exception 'FAIL (Q7): unexpected error: %', msg; end if;
  end;

  -- Q8: once a results row exists, a running attempt can no longer finish. (Fresh event so u4's row is valid.)
  ev2 := pg_temp.mk_event('quiz', 0, 4, 10);
  insert into guild_quiz_attempts (event_id, user_id, started_at) values (ev2, u4, now() - interval '10 seconds');
  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by)
  values (inkroot_official_guild_id(), ev2, '[]'::jsonb, 'pending_approval', u1);
  perform pg_temp.act_as_user(u4);
  begin
    perform submit_guild_quiz_attempt(ev2, '{}'::jsonb);
    raise exception 'FAIL (Q8): a submit after results existed was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%closed%' then raise exception 'FAIL (Q8): unexpected error: %', msg; end if;
  end;
  perform pg_temp.act_as_none();
  raise notice 'PASS: quiz grading Q1-Q8';

  -- ==========================================================================================
  -- QUIZ RANKING
  -- ==========================================================================================
  ev := pg_temp.mk_event('quiz', 0, 4, 10);
  insert into guild_event_objective_config (event_id, guild_id, metric, weight_bps, placement_split_bps, locked, locked_at, created_by)
  values (ev, inkroot_official_guild_id(), guild_event_judge_free_metric('reading_challenge'), 10000,
          '[{"place":1,"share_bps":5000},{"place":2,"share_bps":3000},{"place":3,"share_bps":2000}]'::jsonb,
          true, now(), null);
  u1 := gen_random_uuid(); u2 := gen_random_uuid(); u3 := gen_random_uuid(); u4 := gen_random_uuid();
  insert into auth.users (id) values (u1), (u2), (u3), (u4);

  -- R2 first: nobody has submitted yet.
  begin
    perform official_event_placements(ev);
    raise exception 'FAIL (R2): placements were computed with no submissions';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%nobody submitted%' then raise exception 'FAIL (R2): unexpected error: %', msg; end if;
  end;

  -- u1: 10/10 in 50 s. u2: 10/10 in 40 s, first in. u4: 10/10 in 40 s, a minute later. u3: 8/10 in 10 s.
  insert into guild_quiz_attempts (event_id, user_id, started_at, submitted_at, score, total, elapsed_ms) values
    (ev, u1, now() - interval '10 minutes', now() - interval '9 minutes',  10, 10, 50000),
    (ev, u2, now() - interval '10 minutes', now() - interval '8 minutes',  10, 10, 40000),
    (ev, u4, now() - interval '10 minutes', now() - interval '7 minutes',  10, 10, 40000),
    (ev, u3, now() - interval '10 minutes', now() - interval '6 minutes',   8, 10, 10000);
  pl := official_event_placements(ev);
  -- Expected: 1st u2 (equal score and time to u4, but submitted first), 2nd u4, 3rd u1; u3 gets nothing (only 3 places).
  if jsonb_array_length(pl) <> 3 then raise exception 'FAIL (R1): expected 3 placements, got %', pl; end if;
  if (pl -> 0 ->> 'contributor_id')::uuid <> u2 or (pl -> 1 ->> 'contributor_id')::uuid <> u4
     or (pl -> 2 ->> 'contributor_id')::uuid <> u1 then
    raise exception 'FAIL (R1): wrong order, got %', pl;
  end if;
  if (select sum((e ->> 'share_bps')::integer) from jsonb_array_elements(pl) e) <> 10000 then
    raise exception 'FAIL (R1): shares do not add to 10000: %', pl;
  end if;
  if (pl -> 0 ->> 'share_bps')::integer <> 5000 or (pl -> 1 ->> 'share_bps')::integer <> 3000
     or (pl -> 2 ->> 'share_bps')::integer <> 2000 then
    raise exception 'FAIL (R1): shares should follow the 50/30/20 split, got %', pl;
  end if;
  raise notice 'PASS: quiz ranking R1-R2';

  -- ==========================================================================================
  -- BRACKET
  -- ==========================================================================================
  for k in 1..array_length(ns, 1) loop
    for run in 1..5 loop
      ev := pg_temp.mk_event('tournament', ns[k], 4, 15);
      perform guild_tournament_build_bracket(ev);
      select * into t from guild_event_tournaments where event_id = ev;
      if t.status <> 'running' or t.bracket_size <> exp_sizes[k] or t.bracket_rounds <> exp_rounds[k]
         or t.current_round <> 1 or jsonb_array_length(t.round_deadlines) <> exp_rounds[k] then
        raise exception 'FAIL (B1): % entrants -> status %, size %, rounds %, current %, deadlines % (expected size %, rounds %)',
          ns[k], t.status, t.bracket_size, t.bracket_rounds, t.current_round, jsonb_array_length(t.round_deadlines),
          exp_sizes[k], exp_rounds[k];
      end if;
      select count(*) into v_byes from guild_event_tournament_matches where event_id = ev and round = 1 and is_bye;
      if v_byes <> exp_byes[k] then
        raise exception 'FAIL (B1): % entrants -> % byes (expected %)', ns[k], v_byes, exp_byes[k];
      end if;
      if (select count(*) from guild_event_tournament_matches where event_id = ev and round = 1) <> exp_sizes[k] / 2 then
        raise exception 'FAIL (B1): % entrants -> wrong number of round-1 matches', ns[k];
      end if;

      -- B2: every entrant exactly once in round 1.
      if (select count(*) from (
            select player_a as u from guild_event_tournament_matches where event_id = ev and round = 1 and player_a is not null
            union all
            select player_b from guild_event_tournament_matches where event_id = ev and round = 1 and player_b is not null
          ) x) <> ns[k]
         or (select count(distinct u) from (
            select player_a as u from guild_event_tournament_matches where event_id = ev and round = 1 and player_a is not null
            union all
            select player_b from guild_event_tournament_matches where event_id = ev and round = 1 and player_b is not null
          ) x) <> ns[k]
         or exists (
            select 1 from (
              select player_a as u from guild_event_tournament_matches where event_id = ev and round = 1 and player_a is not null
              union all
              select player_b from guild_event_tournament_matches where event_id = ev and round = 1 and player_b is not null
            ) x where u not in (select entrant_id from guild_event_entries where event_id = ev and status = 'success')
         ) then
        raise exception 'FAIL (B2): % entrants -> round 1 does not hold each entrant exactly once', ns[k];
      end if;
      -- Byes: alone in their match, already resolved for player_a; real matches: open with 10 questions.
      if exists (select 1 from guild_event_tournament_matches
                 where event_id = ev and round = 1 and is_bye
                   and (player_b is not null or status <> 'resolved' or winner_id is distinct from player_a or decided_by <> 'bye')) then
        raise exception 'FAIL (B2): % entrants -> a bye match is malformed', ns[k];
      end if;
      if exists (select 1 from guild_event_tournament_matches x
                 where x.event_id = ev and x.round = 1 and not x.is_bye
                   and (x.status <> 'open' or x.player_a is null or x.player_b is null or x.player_a = x.player_b
                        or (select count(*) from guild_event_tournament_match_questions q where q.match_id = x.id) <> 10)) then
        raise exception 'FAIL (B2): % entrants -> a real match is not open with 10 questions', ns[k];
      end if;
      if exists (select 1 from guild_event_tournament_matches
                 where event_id = ev and round >= 2 and status <> 'waiting') then
        raise exception 'FAIL (B2): % entrants -> a later round is not waiting', ns[k];
      end if;
    end loop;
  end loop;
  raise notice 'PASS: bracket sizes, byes and seeding B1-B2 (6 sizes x 5 runs)';

  -- B3: too many entrants for the bracket, too few, and a second build.
  ev := pg_temp.mk_event('tournament', 9, 3, 15);
  begin
    perform guild_tournament_build_bracket(ev);
    raise exception 'FAIL (B3): 9 entrants fit into a 3-round bracket';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%more entrants than its bracket can hold%' then raise exception 'FAIL (B3): unexpected error: %', msg; end if;
  end;
  ev := pg_temp.mk_event('tournament', 1, 4, 15);
  begin
    perform guild_tournament_build_bracket(ev);
    raise exception 'FAIL (B3): a bracket was built for 1 entrant';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%at least 2%' then raise exception 'FAIL (B3): unexpected error: %', msg; end if;
  end;
  ev := pg_temp.mk_event('tournament', 4, 4, 15);
  perform guild_tournament_build_bracket(ev);
  begin
    perform guild_tournament_build_bracket(ev);
    raise exception 'FAIL (B3): a second build was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%already been built%' then raise exception 'FAIL (B3): unexpected error: %', msg; end if;
  end;
  raise notice 'PASS: bracket refusals B3';

  -- ==========================================================================================
  -- MATCH RESOLUTION (2 players -> exactly one match)
  -- ==========================================================================================
  -- M1: before the deadline nothing happens.
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 9, 30000);
  perform pg_temp.play(m, 'b', 1, 30000);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.status <> 'open' or mt.winner_id is not null then
    raise exception 'FAIL (M1): a match was resolved before its deadline (status %)', mt.status;
  end if;

  -- M2: higher score wins.
  update guild_event_tournament_matches set deadline_at = now() - interval '1 minute' where id = m;
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.status <> 'resolved' or mt.winner_id <> mt.player_a or mt.decided_by <> 'score' then
    raise exception 'FAIL (M2): expected player_a by score, got winner % by %', mt.winner_id, mt.decided_by;
  end if;
  -- ...and resolving again changes nothing.
  perform guild_tournament_resolve_match(m);
  if (select resolved_at from guild_event_tournament_matches where id = m) is distinct from mt.resolved_at then
    raise exception 'FAIL (M2): a resolved match was resolved again';
  end if;
  -- ...and the lower score losing on the other side.
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 2, 10000);
  perform pg_temp.play(m, 'b', 8, 90000);   -- slower but more right: score beats time
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_b or mt.decided_by <> 'score' then
    raise exception 'FAIL (M2): expected player_b by score, got winner % by %', mt.winner_id, mt.decided_by;
  end if;

  -- M3: equal score, the faster side wins (both directions).
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 6, 30000);
  perform pg_temp.play(m, 'b', 6, 40000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_a or mt.decided_by <> 'time' then
    raise exception 'FAIL (M3): expected player_a by time, got winner % by %', mt.winner_id, mt.decided_by;
  end if;
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 6, 50000);
  perform pg_temp.play(m, 'b', 6, 20000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_b or mt.decided_by <> 'time' then
    raise exception 'FAIL (M3): expected player_b by time, got winner % by %', mt.winner_id, mt.decided_by;
  end if;

  -- M4: equal score and time -> random, but always one of the two players.
  for run in 1..10 loop
    ev := pg_temp.mk_event('tournament', 2, 4, 15);
    perform guild_tournament_build_bracket(ev);
    select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
    perform pg_temp.play(m, 'a', 5, 25000);
    perform pg_temp.play(m, 'b', 5, 25000);
    perform pg_temp.expire_open(ev);
    perform guild_tournament_resolve_match(m);
    select * into mt from guild_event_tournament_matches where id = m;
    if mt.decided_by <> 'random' or mt.winner_id not in (mt.player_a, mt.player_b) then
      raise exception 'FAIL (M4): expected a random pick of the two, got winner % by %', mt.winner_id, mt.decided_by;
    end if;
  end loop;

  -- M5: only one side submitted -> walkover for that side (a, then b).
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 0, 44000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_a or mt.decided_by <> 'walkover' then
    raise exception 'FAIL (M5): expected player_a by walkover, got winner % by %', mt.winner_id, mt.decided_by;
  end if;
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'b', 0, 44000);   -- even a score of 0 beats not showing up
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_b or mt.decided_by <> 'walkover' then
    raise exception 'FAIL (M5): expected player_b by walkover, got winner % by %', mt.winner_id, mt.decided_by;
  end if;

  -- M6: started but never submitted counts as not played.
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  update guild_event_tournament_matches set a_started_at = now() - interval '10 minutes' where id = m;
  perform pg_temp.play(m, 'b', 3, 40000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.winner_id <> mt.player_b or mt.decided_by <> 'walkover' then
    raise exception 'FAIL (M6): a started-only side should lose by walkover, got winner % by %', mt.winner_id, mt.decided_by;
  end if;

  -- M7: neither played -> nobody wins.
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_match(m);
  select * into mt from guild_event_tournament_matches where id = m;
  if mt.status <> 'resolved' or mt.winner_id is not null or mt.decided_by <> 'none' then
    raise exception 'FAIL (M7): expected no winner by none, got winner % by %', mt.winner_id, mt.decided_by;
  end if;
  raise notice 'PASS: match resolution M1-M7';

  -- ==========================================================================================
  -- ADVANCING AND THE PODIUM
  -- ==========================================================================================
  -- A1: 4 players, no byes. Player A wins both semifinals; the losers scored 3 and 6.
  ev := pg_temp.mk_event('tournament', 4, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m1 from guild_event_tournament_matches where event_id = ev and round = 1 and slot = 0;
  select id into m2 from guild_event_tournament_matches where event_id = ev and round = 1 and slot = 1;
  perform pg_temp.play(m1, 'a', 8, 30000); perform pg_temp.play(m1, 'b', 3, 30000);
  perform pg_temp.play(m2, 'a', 9, 30000); perform pg_temp.play(m2, 'b', 6, 30000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);

  select * into t from guild_event_tournaments where event_id = ev;
  if t.status <> 'running' or t.current_round <> 2 then
    raise exception 'FAIL (A1): expected running in round 2, got % round %', t.status, t.current_round;
  end if;
  select * into mt from guild_event_tournament_matches where event_id = ev and round = 2 and slot = 0;
  if mt.status <> 'open'
     or mt.player_a is distinct from (select player_a from guild_event_tournament_matches where id = m1)
     or mt.player_b is distinct from (select player_a from guild_event_tournament_matches where id = m2) then
    raise exception 'FAIL (A1): the final should open with the two semifinal winners (status %)', mt.status;
  end if;
  fin := mt.id;
  if (select count(*) from guild_event_tournament_match_questions where match_id = fin) <> 10 then
    raise exception 'FAIL (A1): the final did not draw 10 questions';
  end if;

  perform pg_temp.play(fin, 'a', 9, 20000);
  perform pg_temp.play(fin, 'b', 4, 20000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);

  select * into t from guild_event_tournaments where event_id = ev;
  if t.status <> 'finished' then raise exception 'FAIL (A1): expected finished, got %', t.status; end if;
  select * into mt from guild_event_tournament_matches where id = fin;
  if t.champion_id is distinct from mt.player_a then raise exception 'FAIL (A1): wrong champion'; end if;
  if t.runner_up_id is distinct from mt.player_b then raise exception 'FAIL (A1): wrong runner-up'; end if;
  if t.third_id is distinct from (select player_b from guild_event_tournament_matches where id = m2) then
    raise exception 'FAIL (A1): third place should be the better semifinal loser (scored 6)';
  end if;
  if (select approval_status || '/' || status from guild_events where id = ev) <> 'completed/closed' then
    raise exception 'FAIL (A1): the event should be completed and closed';
  end if;
  if exists (select 1 from guild_event_prize_payouts where event_id = ev) then
    raise exception 'FAIL (A1): a tournament must not be paid automatically';
  end if;
  -- The podium is what official_event_placements() reads: no config row here, so it must say so rather than guess.
  begin
    perform official_event_placements(ev);
    raise exception 'FAIL (A1): placements computed without a prize split on file';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%no prize split on file%' then raise exception 'FAIL (A1): unexpected error: %', msg; end if;
  end;

  -- A2: everybody no-shows -> no_contest.
  ev := pg_temp.mk_event('tournament', 4, 4, 15);
  perform guild_tournament_build_bracket(ev);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);
  select * into t from guild_event_tournaments where event_id = ev;
  if t.status <> 'no_contest' or t.champion_id is not null or t.runner_up_id is not null or t.third_id is not null then
    raise exception 'FAIL (A2): expected no_contest with no podium, got % / %', t.status, t.champion_id;
  end if;
  if (select approval_status from guild_events where id = ev) <> 'completed' then
    raise exception 'FAIL (A2): the event should still be completed';
  end if;

  -- A3: 3 players (bracket of 4, one bye). The one real match is a no-show, so the bye player walks through.
  for run in 1..5 loop
    ev := pg_temp.mk_event('tournament', 3, 4, 15);
    perform guild_tournament_build_bracket(ev);
    select player_a into u1 from guild_event_tournament_matches where event_id = ev and round = 1 and is_bye;
    perform pg_temp.expire_open(ev);
    perform guild_tournament_resolve_event(ev);
    select * into t from guild_event_tournaments where event_id = ev;
    if t.status <> 'finished' or t.champion_id is distinct from u1 then
      raise exception 'FAIL (A3): expected the bye player to be champion, got % / %', t.status, t.champion_id;
    end if;
    if t.runner_up_id is not null or t.third_id is not null then
      raise exception 'FAIL (A3): nobody played the final or a semifinal, so no runner-up or third';
    end if;
    if (select decided_by from guild_event_tournament_matches where event_id = ev and round = 2 and slot = 0) <> 'bye' then
      raise exception 'FAIL (A3): the final should be recorded as a bye';
    end if;
  end loop;

  -- A4: 2 players, only one played -> champion by walkover; no runner-up (the loser did not play), no third (no semifinal).
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'b', 1, 40000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);
  select * into t from guild_event_tournaments where event_id = ev;
  select * into mt from guild_event_tournament_matches where id = m;
  if t.status <> 'finished' or t.champion_id is distinct from mt.player_b or t.runner_up_id is not null or t.third_id is not null then
    raise exception 'FAIL (A4): expected champion = player_b only, got champion %, runner-up %, third %',
      t.champion_id, t.runner_up_id, t.third_id;
  end if;

  -- A5: 2 players, both played -> the loser is runner-up.
  ev := pg_temp.mk_event('tournament', 2, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m from guild_event_tournament_matches where event_id = ev and round = 1;
  perform pg_temp.play(m, 'a', 7, 30000);
  perform pg_temp.play(m, 'b', 2, 30000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);
  select * into t from guild_event_tournaments where event_id = ev;
  select * into mt from guild_event_tournament_matches where id = m;
  if t.champion_id is distinct from mt.player_a or t.runner_up_id is distinct from mt.player_b or t.third_id is not null then
    raise exception 'FAIL (A5): expected champion player_a, runner-up player_b, no third';
  end if;

  -- A6: 4 players. Semifinal 1 is a walkover (its loser never played); semifinal 2 was played. Third goes to semifinal 2's loser.
  ev := pg_temp.mk_event('tournament', 4, 4, 15);
  perform guild_tournament_build_bracket(ev);
  select id into m1 from guild_event_tournament_matches where event_id = ev and round = 1 and slot = 0;
  select id into m2 from guild_event_tournament_matches where event_id = ev and round = 1 and slot = 1;
  perform pg_temp.play(m1, 'a', 9, 20000);                                  -- b never plays
  perform pg_temp.play(m2, 'a', 9, 20000); perform pg_temp.play(m2, 'b', 2, 20000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);
  select id into fin from guild_event_tournament_matches where event_id = ev and round = 2 and slot = 0;
  perform pg_temp.play(fin, 'a', 8, 20000); perform pg_temp.play(fin, 'b', 5, 20000);
  perform pg_temp.expire_open(ev);
  perform guild_tournament_resolve_event(ev);
  select * into t from guild_event_tournaments where event_id = ev;
  if t.status <> 'finished' then raise exception 'FAIL (A6): expected finished, got %', t.status; end if;
  if t.third_id is distinct from (select player_b from guild_event_tournament_matches where id = m2) then
    raise exception 'FAIL (A6): third should be the semifinal loser who played, not the one who did not show';
  end if;
  if t.third_id = (select player_b from guild_event_tournament_matches where id = m1) then
    raise exception 'FAIL (A6): a no-show took third place';
  end if;
  raise notice 'PASS: advancing and podium A1-A6';

  raise notice 'PASS: quiz grading, quiz ranking, bracket building, match resolution and podium (all cases)';
end;
$$;

rollback;
