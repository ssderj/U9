-- 176_migration_tournament_backend.sql
--
-- The Tournament event type (reading brackets only), end to end, on the design in the backend spec
-- (section 3) and the decisions the pre-implementation review settled. Keeps the existing structure:
-- tournament setup is a separate call after the draft is saved (as set_guild_quiz_settings is for a
-- quiz), the question pool and answer-key rules are 174's, the judge-free config is 169's, ranking
-- goes through compute_guild_event_placements() and the payout is the 168 escrow path.
--
--   * A tournament has 4-6 rounds chosen by the host (a CEILING). Entry stays paid; the player limit
--     defaults to 2^rounds and can only be lowered. Closing entries (the host's button, or the end
--     date) locks the bracket: the entrants are shuffled on the server, the bracket is the smallest
--     power of two that fits them (11 entrants -> 16 slots, 4 rounds even if the host chose 6), and the
--     empty slots become byes handed to RANDOM first-round matches, so a bye never meets a bye.
--   * ONE ROUND PER DAY. Round r ends r x 24 hours after entries closed. Each player plays any time
--     before then. A scheduled job (resolve_tournament_rounds(), every 5 minutes) decides each match at
--     its deadline: more correct answers wins, faster server-measured time breaks a tie, a tie on both
--     is a server-side random decider (recorded on the match); only one player played -> they win;
--     neither -> both are out and the next slot is empty (its other feeder's winner gets a bye). The
--     bracket advances round by round in a loop, never recursively.
--   * A MATCH: both opponents get the same random 10 questions from the event's pool, in the same
--     order, with the OPTIONS shuffled per player. 45 seconds per question (plus the quiz's 5-second
--     grace), one attempt, server clock, answer keys never sent. An opponent's score stays hidden until
--     the match is decided. Tab-switch counts are stored and readable only by the hosting guild's
--     owner and Inkroot admins (list_flagged_tournament_attempts) — a review signal, never a
--     disqualification.
--   * PRIZES: 1st = champion, 2nd = the losing finalist, 3rd = the semifinal loser with the most
--     correct answers (speed, then chance, breaks ties). 2nd and 3rd only go to players who actually
--     played that last match. A 1-round bracket (2 players) has no semifinal, so no 3rd. When a place
--     isn't awarded its share is re-scaled across the places that were, in proportion to the host's
--     declared split (NOT handed to 1st alone). Placements are computed by the existing
--     compute_guild_event_placements() from the finished bracket, and — like a quiz — NOT paid
--     automatically: the host or Inkroot presses compute, so an officer can review flagged attempts first.
--
-- Reuses 174's bank: the pool tables, the frozen-at-opening rule, and the fairness rule (a writer of a
-- question in the pool can't enter — guild_quiz_user_wrote_for_event(); members of the hosting guild
-- already can't enter, 169). A tournament keeps its own book choice in guild_event_tournaments
-- because guild_events.quiz_source stays quiz-only; guild_quiz_event_source()/guild_quiz_event_anthology()
-- are the one place that difference lives. A tournament needs 15 approved questions in its pool to open
-- (each match draws 10) and its pool may hold up to 50.
--
-- DECISIONS to know about (the spec left them open, or a small correction to the review):
--   * FEWER THAN 2 ENTRANTS. The spec said "cancel and refund through the existing cancel flow", but
--     cancel_guild_event() refuses any event with a paid entrant and the app has never called Paystack's
--     refund API (108). So: the host can't close entries below 2 paid entrants (plain message — wait
--     for more). If the END DATE arrives first, the tournament ends as 'no_contest' (completed, no
--     bracket, nothing to compute); an Inkroot admin can force-cancel it (admin_cancel_guild_event_dispute)
--     to release the escrowed prize, and entry fees are refunded by hand, exactly as for any event today.
--   * THE END DATE IS THE ENTRY DEADLINE. The hourly sweep completes an open event at its end date; for
--     a tournament it closes entries instead and builds the bracket. A closed tournament (status 'closed',
--     approval 'active') is never touched by the sweep — only the resolver completes it, after the final.
--   * complete_guild_event() refuses a tournament (completing mid-bracket would strand it).
--   * A late payment webhook after the bracket exists is refused ('over_limit', row -> 'failed') by
--     apply_guild_event_entry_payment(), which makes the webhook alert ops for a manual refund.
--   * "Played" means SUBMITTED before the deadline. Starting a match and never submitting counts as not
--     playing. A player can start until 30 seconds before the deadline; their timer is then shortened
--     to the time left.
--   * Correction to the review: it said a 2-round bracket has no semifinal losers. Round 1 of a 2-round
--     bracket IS the semifinal, so it does have them; only the 1-round bracket (2 players) has no 3rd.
--   * Answer leaking between matches in the same round (same pool) is reduced (random subset, per-player
--     option shuffle), not eliminated. Accepted, as the panel already noted.
--
-- Not built here: an Inkroot-wide official bank (174 still says so), writing brackets (out of scope).
-- RLS is on for every new table with NO client policies; every read and write goes through the
-- security-definer functions below. Not run against a live database — like 167-175 this ships with a
-- checklist section (supabase/tests/167-171_two_account_checklist.md, section 15) instead of automated tests.
-- Safe to apply once; functions are create-or-replace and the trigger/cron entries are re-creatable.
-- Requires pg_cron (already enabled — see 129).


-- 1. Schema ------------------------------------------------------------------------------------
-- One row per tournament event. Written by set_guild_tournament_settings() while the event is a
-- draft; after that only the bracket functions below touch it.
create table if not exists guild_event_tournaments (
  event_id uuid primary key references guild_events(id) on delete cascade,
  rounds integer not null check (rounds between 4 and 6),         -- what the host chose: the bracket's CEILING
  source text not null check (source in ('anthology', 'none')),   -- same meaning as a quiz's source (the question bank)
  anthology_id uuid references guild_anthologies(id) on delete set null,
  status text not null default 'entries_open'
    check (status in ('entries_open', 'running', 'finished', 'no_contest')),
  entries_closed_at timestamptz,
  bracket_size integer,                                           -- smallest power of two that fits the entrants (<= 2^rounds)
  bracket_rounds integer,                                         -- log2(bracket_size): the rounds actually played
  current_round integer,
  round_deadlines jsonb not null default '[]'::jsonb,             -- [iso timestamp per round], set when the bracket is built
  champion_id uuid references auth.users(id) on delete set null,
  runner_up_id uuid references auth.users(id) on delete set null,
  third_id uuid references auth.users(id) on delete set null,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table guild_event_tournaments enable row level security;
-- No policies: nothing here is readable or writable by a client. Reads go through
-- get_guild_tournament_settings() and get_my_tournament_state().

create table if not exists guild_event_tournament_matches (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  round integer not null check (round >= 1),
  slot integer not null check (slot >= 0),
  player_a uuid references auth.users(id) on delete set null,
  player_b uuid references auth.users(id) on delete set null,
  is_bye boolean not null default false,                          -- player_a alone, moves on without playing
  -- waiting = its feeder matches haven't both been decided; open = both players known and playable;
  -- resolved = a winner (or nobody) has been recorded.
  status text not null default 'waiting' check (status in ('waiting', 'open', 'resolved')),
  winner_id uuid references auth.users(id) on delete set null,
  decided_by text check (decided_by is null or decided_by in ('score', 'time', 'random', 'walkover', 'bye', 'none')),
  deadline_at timestamptz not null,
  -- Each side's attempt. Scores stay server-side until the match is resolved; tab_switches is a
  -- review signal only officers/admins can read (list_flagged_tournament_attempts).
  a_started_at timestamptz, a_submitted_at timestamptz, a_answers jsonb,
  a_score integer, a_elapsed_ms integer, a_tab_switches integer,
  b_started_at timestamptz, b_submitted_at timestamptz, b_answers jsonb,
  b_score integer, b_elapsed_ms integer, b_tab_switches integer,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, round, slot)
);
alter table guild_event_tournament_matches enable row level security;
-- No policies, same reason as above.
create index if not exists guild_event_tournament_matches_open_idx
  on guild_event_tournament_matches (deadline_at) where status = 'open';
create index if not exists guild_event_tournament_matches_player_a_idx on guild_event_tournament_matches (player_a);
create index if not exists guild_event_tournament_matches_player_b_idx on guild_event_tournament_matches (player_b);

-- The random subset of the event's question pool one match draws (the same for both opponents).
create table if not exists guild_event_tournament_match_questions (
  match_id uuid not null references guild_event_tournament_matches(id) on delete cascade,
  position integer not null check (position >= 1),
  question_id uuid not null references guild_quiz_questions(id) on delete cascade,
  primary key (match_id, position),
  unique (match_id, question_id)
);
alter table guild_event_tournament_match_questions enable row level security;
-- No policies: questions reach an entrant only through start_tournament_match(), never with the key.
create index if not exists guild_event_tournament_match_questions_question_idx
  on guild_event_tournament_match_questions (question_id);

-- 2. Constants and helpers ---------------------------------------------------------------------
-- Approved questions an event's pool needs before a tournament can open; each match draws 10 of them.
create or replace function guild_tournament_min_pool() returns integer as $$ select 15; $$ language sql immutable;
create or replace function guild_tournament_questions_per_match() returns integer as $$ select 10; $$ language sql immutable;
-- Time allowance per question (the total for a match is this x the number of questions, plus the
-- quiz's 5-second grace), and the length of one round.
create or replace function guild_tournament_seconds_per_question() returns integer as $$ select 45; $$ language sql immutable;
create or replace function guild_tournament_round_hours() returns integer as $$ select 24; $$ language sql immutable;
-- A tournament's pool may be larger than an ordinary quiz's (the spec asks for 30-50).
create or replace function guild_tournament_question_cap() returns integer as $$ select 50; $$ language sql immutable;
revoke all on function guild_tournament_min_pool(), guild_tournament_questions_per_match(),
  guild_tournament_seconds_per_question(), guild_tournament_round_hours(), guild_tournament_question_cap()
  from public, anon, authenticated;

-- The name shown in a bracket: display name, else pen name.
create or replace function guild_tournament_display_name(p_user_id uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(trim(p.display_name), '') from profiles p where p.id = p_user_id),
    (select nullif(trim(p.pen_name), '') from profiles p where p.id = p_user_id),
    'Player');
$$;
revoke all on function guild_tournament_display_name(uuid) from public, anon, authenticated;

-- 3. The question bank reads a tournament's own book choice -----------------------------------
-- guild_events.quiz_source / quiz_anthology_id stay quiz-only (migration 172's check constraint), so a
-- tournament keeps its book in guild_event_tournaments. These two helpers are the ONE place that
-- difference lives; every pool function from 174 already asks guild_quiz_event_anthology().
-- (Was 'immutable' in 174 — it now reads a table, hence 'stable'.)
create or replace function guild_quiz_event_source(p_event guild_events)
returns text
language sql stable security definer set search_path = public as $$
  select case when p_event.event_type = 'tournament'
    then (select t.source from guild_event_tournaments t where t.event_id = p_event.id)
    else p_event.quiz_source end;
$$;
revoke all on function guild_quiz_event_source(guild_events) from public, anon, authenticated;

create or replace function guild_quiz_event_anthology(p_event guild_events)
returns uuid
language sql stable security definer set search_path = public as $$
  select case
    when p_event.event_type = 'tournament'
      then (select case when t.source = 'anthology' then t.anthology_id end
            from guild_event_tournaments t where t.event_id = p_event.id)
    when p_event.quiz_source = 'anthology' then p_event.quiz_anthology_id
    else null end;
$$;
revoke all on function guild_quiz_event_anthology(guild_events) from public, anon, authenticated;


-- 4. The pool functions accept a tournament (174's bodies, each change marked "Migration 176") ---
-- guild_quiz_attach_to_pool / host_add_guild_quiz_question / suggest_guild_quiz_question were hard-coded to
-- reading_challenge and to guild_events.quiz_source. Now: a tournament is allowed, its book comes from
-- guild_quiz_event_source(), and its pool cap is 50. Nothing else about them changed.

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
  -- Migration 176: a tournament draws from the same pool.
  if v_event.host <> 'guild' or v_event.event_type not in ('reading_challenge', 'tournament') then
    raise exception 'Questions only apply to a Reading & Trivia or Tournament event.';
  end if;
  if not guild_quiz_questions_editable(v_event.approval_status) then
    raise exception 'The questions are locked once the event is with Inkroot or open.';
  end if;
  if guild_quiz_event_source(v_event) is null then
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

-- 5. Host: tournament settings (a separate call after the draft is saved, like set_guild_quiz_settings) --
-- The draft RPCs stay untouched. Rounds (4-6) and the book are editable while the event is a draft
-- and locked from the moment it leaves draft. The player limit defaults to 2^rounds and can be
-- lowered, never raised past it (a bracket of N rounds holds at most 2^N players).
create or replace function set_guild_tournament_settings(
  p_event_id uuid, p_rounds integer, p_source text, p_anthology_id uuid
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_old_bank uuid;
  v_new_bank uuid;
  v_had boolean;
  v_max integer;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  perform guild_officer_gate(v_event.guild_id, 'Only the guild owner can set up this tournament.');
  if v_event.host <> 'guild' or v_event.event_type <> 'tournament' then
    raise exception 'Tournament settings only apply to a Tournament event.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Tournament settings can only be changed while the event is a draft.';
  end if;
  if p_rounds is null or p_rounds < 4 or p_rounds > 6 then
    raise exception 'A tournament runs for 4 to 6 rounds.';
  end if;
  if p_source is null or p_source not in ('anthology', 'none') then
    raise exception 'Choose the guild''s anthology or no book (trivia).';
  end if;
  if p_source = 'anthology' and not exists (
    select 1 from guild_anthologies a where a.id = p_anthology_id and a.guild_id = v_event.guild_id
  ) then
    raise exception 'Choose one of this guild''s own anthologies.';
  end if;

  v_new_bank := case when p_source = 'anthology' then p_anthology_id else null end;
  select case when t.source = 'anthology' then t.anthology_id else null end into v_old_bank
  from guild_event_tournaments t where t.event_id = p_event_id;
  v_had := found;
  -- The pool must come from the same bank as the event, so choosing a different book empties it.
  if v_had and v_old_bank is distinct from v_new_bank then
    delete from guild_event_quiz_pool where event_id = p_event_id;
  end if;

  insert into guild_event_tournaments (event_id, rounds, source, anthology_id)
  values (p_event_id, p_rounds, p_source, v_new_bank)
  on conflict (event_id) do update
    set rounds = excluded.rounds, source = excluded.source, anthology_id = excluded.anthology_id,
        updated_at = now();

  v_max := power(2, p_rounds)::integer;
  update guild_events
    set participant_limit = least(coalesce(participant_limit, v_max), v_max)
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function set_guild_tournament_settings(uuid, integer, text, uuid) from public, anon;
grant execute on function set_guild_tournament_settings(uuid, integer, text, uuid) to authenticated;

-- What the host form and the event card read. Nothing secret: rounds, book, and where the bracket is.
create or replace function get_guild_tournament_settings(p_event_id uuid)
returns table (
  rounds integer, source text, anthology_id uuid, status text, bracket_size integer,
  bracket_rounds integer, current_round integer, entries_closed_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  select * into v_event from guild_events e where e.id = p_event_id;
  if not found or v_event.event_type <> 'tournament' then
    return;
  end if;
  if not (v_event.approval_status in ('published', 'active', 'completed')
          or is_guild_officer(v_event.guild_id) or is_inkroot_admin()) then
    return;
  end if;
  return query
    select t.rounds, t.source, t.anthology_id, t.status, t.bracket_size, t.bracket_rounds,
           t.current_round, t.entries_closed_at
    from guild_event_tournaments t where t.event_id = p_event_id;
end;
$$;
revoke all on function get_guild_tournament_settings(uuid) from public, anon;
grant execute on function get_guild_tournament_settings(uuid) to authenticated;

-- 6. Opening gate ------------------------------------------------------------------------------
-- Same shape as 174's guild_quiz_activation_gate(): a trigger, so activate_guild_event() keeps its
-- single latest body. It fires after activate_guild_event() has written the judge-free config, so it
-- can read the host's saved prize split. The pool is frozen from here — every pool edit checks the
-- event is still editable (guild_quiz_questions_editable) — and the settings are locked because
-- set_guild_tournament_settings() only works on a draft.
create or replace function guild_tournament_activation_gate()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_t guild_event_tournaments%rowtype;
  v_max integer;
  v_in_pool integer;
  v_split jsonb;
begin
  if new.host = 'guild' and new.event_type = 'tournament'
     and new.approval_status = 'active' and old.approval_status is distinct from 'active' then
    select * into v_t from guild_event_tournaments where event_id = new.id;
    if not found or (v_t.source = 'anthology' and v_t.anthology_id is null) then
      raise exception 'Set up this tournament (rounds and question source) before opening it.';
    end if;

    v_max := power(2, v_t.rounds)::integer;
    if new.participant_limit is null then
      new.participant_limit := v_max;
    elsif new.participant_limit < 2 or new.participant_limit > v_max then
      raise exception 'A %-round tournament holds between 2 and % players — change the player limit.', v_t.rounds, v_max;
    end if;

    select count(*) into v_in_pool
    from guild_event_quiz_pool p
    join guild_quiz_questions q on q.id = p.question_id
    where p.event_id = new.id and q.status = 'approved';
    if v_in_pool < guild_tournament_min_pool() then
      raise exception 'A tournament needs at least % approved questions in its pool to open (this one has %).',
        guild_tournament_min_pool(), v_in_pool;
    end if;

    -- A tournament pays places 1-3 only. (An unawarded place's share is re-scaled across the places
    -- that were awarded — see compute_guild_event_placements() below.)
    select c.placement_split_bps into v_split from guild_event_objective_config c where c.event_id = new.id;
    if v_split is not null and exists (
      select 1 from jsonb_array_elements(v_split) e where (e->>'place')::integer not between 1 and 3
    ) then
      raise exception 'A tournament pays 1st, 2nd and 3rd place only — remove any other place from the prize split.';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists guild_tournament_activation_gate on guild_events;
create trigger guild_tournament_activation_gate
  before update of approval_status on guild_events
  for each row execute function guild_tournament_activation_gate();

-- 7. Bracket: drawing questions, building, resolving, advancing (all internal — no client can call these) --
-- Every function in this section is revoked from clients. They run inside close_guild_event(),
-- close_ended_guild_events() and resolve_tournament_rounds(). Locks, always taken in this order so
-- nothing can deadlock: 'guild_event_entry:<event>' (entries) -> 'guild_event_tournament:<event>'
-- (a whole-bracket resolution) -> 'guild_tournament_match:<match>' (one match; also what start/submit take).

-- A match's random subset of the event's frozen pool, in random order. Both opponents read the same rows.
create or replace function guild_tournament_draw_questions(p_match_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_n integer;
begin
  select mt.event_id into v_event_id from guild_event_tournament_matches mt where mt.id = p_match_id;
  with picked as (
    select q.id
    from guild_event_quiz_pool p
    join guild_quiz_questions q on q.id = p.question_id
    where p.event_id = v_event_id and q.status = 'approved'
    order by random()
    limit guild_tournament_questions_per_match()
  )
  insert into guild_event_tournament_match_questions (match_id, position, question_id)
  select p_match_id, (row_number() over (order by random()))::integer, picked.id from picked
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function guild_tournament_draw_questions(uuid) from public, anon, authenticated;

-- Builds the whole bracket at once. The caller holds the 'guild_event_entry' lock, so no entry can
-- land mid-build. Size = the smallest power of two that fits the entrants (capped at 2^rounds, which
-- the opening gate guarantees is enough); byes go to RANDOM first-round matches, so a bye never meets
-- another bye and never favours a seed (there are no seeds — the entrants are shuffled server-side).
create or replace function guild_tournament_build_bracket(p_event_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_t guild_event_tournaments%rowtype;
  v_entrants uuid[];
  v_n integer;
  v_size integer := 2;
  v_rounds integer := 1;
  v_matches integer;
  v_byes integer;
  v_bye_slots integer[];
  v_close timestamptz := clock_timestamp();
  v_deadlines jsonb := '[]'::jsonb;
  v_deadline timestamptz;
  v_idx integer := 1;
  v_slot integer;
  v_r integer;
  v_a uuid;
  v_b uuid;
  v_match_id uuid;
begin
  select * into v_t from guild_event_tournaments where event_id = p_event_id for update;
  if not found then
    raise exception 'Tournament not found.';
  end if;
  if v_t.status <> 'entries_open' then
    raise exception 'This tournament''s bracket has already been built.';
  end if;

  select array_agg(e.entrant_id order by random()) into v_entrants
  from guild_event_entries e where e.event_id = p_event_id and e.status = 'success';
  v_n := coalesce(cardinality(v_entrants), 0);
  if v_n < 2 then
    raise exception 'A tournament needs at least 2 paid entrants.';
  end if;

  while v_size < v_n loop
    v_size := v_size * 2;
    v_rounds := v_rounds + 1;
  end loop;
  if v_size > power(2, v_t.rounds)::integer then
    raise exception 'This tournament has more entrants than its bracket can hold.';
  end if;
  v_matches := v_size / 2;
  v_byes := v_size - v_n;   -- always < v_matches once v_size >= 4, so at most one bye per match

  select coalesce(array_agg(s.slot), '{}'::integer[]) into v_bye_slots
  from (select g as slot from generate_series(0, v_matches - 1) g order by random() limit v_byes) s;

  -- One round per day: round r ends r x 24 hours after entries closed.
  for v_r in 1..v_rounds loop
    v_deadlines := v_deadlines || to_jsonb(v_close + make_interval(hours => v_r * guild_tournament_round_hours()));
  end loop;

  v_deadline := v_close + make_interval(hours => guild_tournament_round_hours());
  for v_slot in 0..v_matches - 1 loop
    v_a := v_entrants[v_idx];
    v_idx := v_idx + 1;
    if v_slot = any (v_bye_slots) then
      insert into guild_event_tournament_matches
        (event_id, round, slot, player_a, is_bye, status, winner_id, decided_by, deadline_at, resolved_at)
      values (p_event_id, 1, v_slot, v_a, true, 'resolved', v_a, 'bye', v_deadline, v_close);
    else
      v_b := v_entrants[v_idx];
      v_idx := v_idx + 1;
      insert into guild_event_tournament_matches (event_id, round, slot, player_a, player_b, status, deadline_at)
      values (p_event_id, 1, v_slot, v_a, v_b, 'open', v_deadline)
      returning id into v_match_id;
      perform guild_tournament_draw_questions(v_match_id);
    end if;
  end loop;

  -- The later rounds exist from the start, empty, so the bracket can be shown in full.
  for v_r in 2..v_rounds loop
    v_deadline := v_close + make_interval(hours => v_r * guild_tournament_round_hours());
    for v_slot in 0..(v_size / power(2, v_r)::integer) - 1 loop
      insert into guild_event_tournament_matches (event_id, round, slot, status, deadline_at)
      values (p_event_id, v_r, v_slot, 'waiting', v_deadline);
    end loop;
  end loop;

  update guild_event_tournaments
    set status = 'running', entries_closed_at = v_close, bracket_size = v_size, bracket_rounds = v_rounds,
        current_round = 1, round_deadlines = v_deadlines, updated_at = now()
  where event_id = p_event_id;

  perform guild_tournament_advance(p_event_id);
end;
$$;
revoke all on function guild_tournament_build_bracket(uuid) from public, anon, authenticated;

-- Decides one open match whose deadline has passed:
--   both played  -> more correct answers wins; faster server-measured time breaks a tie; a tie on both
--                   is settled by a server-side random decider, recorded as decided_by = 'random'
--   one played   -> that player wins ('walkover')
--   neither      -> both are out ('none')
-- A player who STARTED but never submitted before the deadline counts as not having played.
-- The caller holds the match lock; the deadline is judged with clock_timestamp() (now() would be the
-- start of the transaction, which may be before a wait on that lock).
create or replace function guild_tournament_resolve_match(p_match_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_m guild_event_tournament_matches%rowtype;
  v_winner uuid;
  v_how text;
begin
  select * into v_m from guild_event_tournament_matches where id = p_match_id for update;
  if not found or v_m.status <> 'open' then
    return;
  end if;
  if clock_timestamp() < v_m.deadline_at then
    return;
  end if;

  if v_m.a_submitted_at is not null and v_m.b_submitted_at is not null then
    if v_m.a_score is distinct from v_m.b_score then
      v_winner := case when v_m.a_score > v_m.b_score then v_m.player_a else v_m.player_b end;
      v_how := 'score';
    elsif v_m.a_elapsed_ms is distinct from v_m.b_elapsed_ms then
      v_winner := case when v_m.a_elapsed_ms < v_m.b_elapsed_ms then v_m.player_a else v_m.player_b end;
      v_how := 'time';
    else
      v_winner := case when random() < 0.5 then v_m.player_a else v_m.player_b end;
      v_how := 'random';
    end if;
  elsif v_m.a_submitted_at is not null then
    v_winner := v_m.player_a;
    v_how := 'walkover';
  elsif v_m.b_submitted_at is not null then
    v_winner := v_m.player_b;
    v_how := 'walkover';
  else
    v_winner := null;
    v_how := 'none';
  end if;

  update guild_event_tournament_matches
    set status = 'resolved', winner_id = v_winner, decided_by = v_how, resolved_at = now()
  where id = p_match_id;
end;
$$;
revoke all on function guild_tournament_resolve_match(uuid) from public, anon, authenticated;

-- Moves the bracket forward for as long as the current round is fully decided. It loops round by
-- round (never recursion), so an all-empty side of the bracket can't run away:
--   * both feeder winners exist            -> the next match opens, with its own random question subset
--   * exactly one feeder winner exists     -> that player gets a bye
--   * neither exists                       -> the slot is empty (nobody moves on from it)
-- After the final it records the podium and completes the event. Everything empty = no winner
-- ('no_contest'). 2nd and 3rd only go to players who actually played their last match.
create or replace function guild_tournament_advance(p_event_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_t guild_event_tournaments%rowtype;
  v_r integer;
  r_next record;
  v_a uuid;
  v_b uuid;
  v_final guild_event_tournament_matches%rowtype;
  v_champion uuid;
  v_runner_up uuid;
  v_third uuid;
begin
  loop
    select * into v_t from guild_event_tournaments where event_id = p_event_id for update;
    exit when not found or v_t.status <> 'running';
    v_r := v_t.current_round;

    -- Still being played.
    exit when exists (
      select 1 from guild_event_tournament_matches x
      where x.event_id = p_event_id and x.round = v_r and x.status <> 'resolved'
    );

    if v_r >= v_t.bracket_rounds then
      select * into v_final from guild_event_tournament_matches x
      where x.event_id = p_event_id and x.round = v_r and x.slot = 0;
      v_champion := v_final.winner_id;

      if v_champion is null then
        update guild_event_tournaments
          set status = 'no_contest', finished_at = now(), updated_at = now()
        where event_id = p_event_id;
      else
        v_runner_up := case
          when v_final.player_a = v_champion and v_final.player_b is not null and v_final.b_submitted_at is not null then v_final.player_b
          when v_final.player_b = v_champion and v_final.player_a is not null and v_final.a_submitted_at is not null then v_final.player_a
          else null end;

        -- 3rd: the semifinal loser with the most correct answers (faster time, then chance, breaks
        -- ties) — only a loser who actually played (both sides submitted) can take it. A bracket
        -- with a single round (2 players) has no semifinal, so no 3rd.
        v_third := null;
        if v_t.bracket_rounds >= 2 then
          select l.uid into v_third from (
            select case when x.player_a = x.winner_id then x.player_b else x.player_a end as uid,
                   case when x.player_a = x.winner_id then x.b_score else x.a_score end as score,
                   case when x.player_a = x.winner_id then x.b_elapsed_ms else x.a_elapsed_ms end as elapsed
            from guild_event_tournament_matches x
            where x.event_id = p_event_id and x.round = v_t.bracket_rounds - 1
              and x.is_bye = false and x.status = 'resolved' and x.winner_id is not null
              and x.a_submitted_at is not null and x.b_submitted_at is not null
          ) l
          where l.uid is not null
          order by l.score desc, l.elapsed asc nulls last, random()
          limit 1;
        end if;

        update guild_event_tournaments
          set status = 'finished', champion_id = v_champion, runner_up_id = v_runner_up, third_id = v_third,
              finished_at = now(), updated_at = now()
        where event_id = p_event_id;
      end if;

      -- The bracket is over: complete the event so the normal results flow (compute -> escrow payout)
      -- can take it from here. It is deliberately NOT paid automatically: officers first get to look
      -- at list_flagged_tournament_attempts().
      update guild_events
        set approval_status = 'completed', status = 'closed', completed_at = now()
      where id = p_event_id and approval_status = 'active';
      exit;
    end if;

    -- Fill the next round from this round's winners.
    for r_next in
      select x.id, x.slot from guild_event_tournament_matches x
      where x.event_id = p_event_id and x.round = v_r + 1 and x.status = 'waiting'
      order by x.slot
    loop
      select w.winner_id into v_a from guild_event_tournament_matches w
        where w.event_id = p_event_id and w.round = v_r and w.slot = r_next.slot * 2;
      select w.winner_id into v_b from guild_event_tournament_matches w
        where w.event_id = p_event_id and w.round = v_r and w.slot = r_next.slot * 2 + 1;

      if v_a is null and v_b is null then
        update guild_event_tournament_matches
          set status = 'resolved', decided_by = 'none', resolved_at = now()
        where id = r_next.id;
      elsif v_a is null or v_b is null then
        update guild_event_tournament_matches
          set player_a = coalesce(v_a, v_b), is_bye = true, status = 'resolved',
              winner_id = coalesce(v_a, v_b), decided_by = 'bye', resolved_at = now()
        where id = r_next.id;
      else
        update guild_event_tournament_matches
          set player_a = v_a, player_b = v_b, status = 'open'
        where id = r_next.id;
        perform guild_tournament_draw_questions(r_next.id);
      end if;
    end loop;

    update guild_event_tournaments set current_round = v_r + 1, updated_at = now() where event_id = p_event_id;
  end loop;
end;
$$;
revoke all on function guild_tournament_advance(uuid) from public, anon, authenticated;

-- One whole tournament: resolve every open match past its deadline, then advance.
create or replace function guild_tournament_resolve_event(p_event_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_match_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('guild_event_tournament:' || p_event_id::text));
  for v_match_id in
    select x.id from guild_event_tournament_matches x
    where x.event_id = p_event_id and x.status = 'open' and x.deadline_at <= clock_timestamp()
    order by x.round, x.slot
  loop
    perform pg_advisory_xact_lock(hashtext('guild_tournament_match:' || v_match_id::text));
    perform guild_tournament_resolve_match(v_match_id);
  end loop;
  perform guild_tournament_advance(p_event_id);
end;
$$;
revoke all on function guild_tournament_resolve_event(uuid) from public, anon, authenticated;

-- The scheduled job (every 5 minutes, see the end of this file). Same cron-only guard as
-- close_ended_guild_events(): a pg_cron job has no JWT, so a postgres/supabase_admin session is
-- accepted, and a signed-in client or the anon key is not. One tournament failing never stops the
-- others. If the job is down for longer than a round, the rounds it missed resolve as no-shows —
-- worth watching cron.job_run_details.
create or replace function resolve_tournament_rounds()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  for v_event_id in
    select t.event_id
    from guild_event_tournaments t
    join guild_events e on e.id = t.event_id
    where t.status = 'running' and e.approval_status = 'active'
  loop
    begin
      perform guild_tournament_resolve_event(v_event_id);
      v_count := v_count + 1;
    exception when others then
      raise warning 'Resolving tournament % failed: %', v_event_id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
revoke all on function resolve_tournament_rounds() from public, anon, authenticated;

-- Closing entries: builds the bracket. Called by close_guild_event() (the host, p_ended = false) and
-- by the hourly sweep once the end date passes (p_ended = true). The caller holds the
-- 'guild_event_entry' lock. Returns 'built' | 'no_contest'.
--   * fewer than 2 paid entrants, host closing   -> refused with a plain message (the existing cancel flow
--     can't refund a paid entrant, so the host waits for more entrants instead — see the header)
--   * fewer than 2 paid entrants, end date hit   -> the tournament ends as 'no_contest' (completed, no
--     bracket, nothing to pay). An Inkroot admin can force-cancel it to return the escrowed prize.
--   * host closing while a checkout is still fresh -> refused, so nobody pays into a bracket that is
--     about to be built without them
create or replace function guild_tournament_close_entries(p_event_id uuid, p_ended boolean)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_t guild_event_tournaments%rowtype;
  v_paid integer;
begin
  select * into v_event from guild_events where id = p_event_id for update;
  if not found or v_event.event_type <> 'tournament' then
    raise exception 'Tournament not found.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'Event not found, not yours, or not open.';
  end if;
  select * into v_t from guild_event_tournaments where event_id = p_event_id for update;
  if not found then
    raise exception 'This tournament has no settings on file.';
  end if;
  if v_t.status <> 'entries_open' then
    raise exception 'This tournament''s entries are already closed.';
  end if;

  select count(*) into v_paid from guild_event_entries where event_id = p_event_id and status = 'success';

  if not p_ended and exists (
    select 1 from guild_event_entries
    where event_id = p_event_id and status = 'pending' and created_at > now() - interval '30 minutes'
  ) then
    raise exception 'Someone is still completing their payment — try again in a few minutes.';
  end if;

  if v_paid < 2 then
    if not p_ended then
      raise exception 'A tournament needs at least 2 paid entrants before entries can close (this one has %). Wait for more entrants.', v_paid;
    end if;
    update guild_event_tournaments
      set status = 'no_contest', entries_closed_at = now(), finished_at = now(), updated_at = now()
    where event_id = p_event_id;
    update guild_events
      set status = 'closed', approval_status = 'completed', completed_at = now()
    where id = p_event_id;
    return 'no_contest';
  end if;

  perform guild_tournament_build_bracket(p_event_id);
  update guild_events set status = 'closed' where id = p_event_id;
  return 'built';
end;
$$;
revoke all on function guild_tournament_close_entries(uuid, boolean) from public, anon, authenticated;

-- 8. Entrants: play a match ---------------------------------------------------------------------
-- The same rules as the quiz (172), per match: the clock is the server's, one attempt per player,
-- the answer key is never sent, grading happens here. A refresh resumes the same running attempt.
-- Returns the match's questions (the same subset, in the same order, for both opponents) with the
-- OPTIONS shuffled per player (a stable per-player order, so a resume shows the same order).
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

-- Grades on the server and measures the time itself. Rejected after the match deadline (the
-- resolver may already be deciding it) and after the player's own time allowance. The tab-switch
-- count is stored for officers/admins only and never returned to anyone else.
create or replace function submit_tournament_match(p_match_id uuid, p_answers jsonb, p_tab_switches integer default 0)
returns table (score integer, total integer, elapsed_ms integer)
language plpgsql security definer set search_path = public as $$
declare
  v_m guild_event_tournament_matches%rowtype;
  v_side text;
  v_started timestamptz;
  v_submitted timestamptz;
  v_now timestamptz;
  v_count integer;
  v_limit integer;
  v_score integer;
  v_total integer;
  v_elapsed integer;
  v_tabs integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in to submit your answers.';
  end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception 'Send your answers as {questionId: optionId}.';
  end if;
  if octet_length(p_answers::text) > 20000 then
    raise exception 'That is too many answers for one match.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_tournament_match:' || p_match_id::text));
  select * into v_m from guild_event_tournament_matches mt where mt.id = p_match_id;
  if not found then
    raise exception 'Match not found.';
  end if;
  v_side := case when v_m.player_a = auth.uid() then 'a' when v_m.player_b = auth.uid() then 'b' else null end;
  if v_side is null then
    raise exception 'This isn''t your match.';
  end if;
  if v_m.is_bye or v_m.status <> 'open' then
    raise exception 'This match has already been decided.';
  end if;

  v_now := clock_timestamp();
  if v_now >= v_m.deadline_at then
    raise exception 'This round has ended — your answers came in too late.';
  end if;
  v_started := case when v_side = 'a' then v_m.a_started_at else v_m.b_started_at end;
  v_submitted := case when v_side = 'a' then v_m.a_submitted_at else v_m.b_submitted_at end;
  if v_started is null then
    raise exception 'Start the match before submitting.';
  end if;
  if v_submitted is not null then
    raise exception 'You''ve already submitted this match.';
  end if;

  select count(*)::integer into v_count from guild_event_tournament_match_questions mq where mq.match_id = p_match_id;
  v_limit := v_count * guild_tournament_seconds_per_question();
  if v_now > v_started + make_interval(secs => v_limit + guild_quiz_grace_seconds()) then
    raise exception 'Time''s up — your answers came in after the time limit.';
  end if;

  select (count(*) filter (where p_answers ->> q.id::text = q.correct_option_id))::integer, count(*)::integer
  into v_score, v_total
  from guild_event_tournament_match_questions mq
  join guild_quiz_questions q on q.id = mq.question_id
  where mq.match_id = p_match_id;

  v_elapsed := least(
    (extract(epoch from (v_now - v_started)) * 1000)::bigint,
    v_limit::bigint * 1000
  )::integer;
  v_tabs := least(greatest(coalesce(p_tab_switches, 0), 0), 1000);

  if v_side = 'a' then
    update guild_event_tournament_matches
      set a_submitted_at = v_now, a_answers = p_answers, a_score = v_score, a_elapsed_ms = v_elapsed, a_tab_switches = v_tabs
    where id = p_match_id;
  else
    update guild_event_tournament_matches
      set b_submitted_at = v_now, b_answers = p_answers, b_score = v_score, b_elapsed_ms = v_elapsed, b_tab_switches = v_tabs
    where id = p_match_id;
  end if;

  return query select v_score, v_total, v_elapsed;
end;
$$;
revoke all on function submit_tournament_match(uuid, jsonb, integer) from public, anon;
grant execute on function submit_tournament_match(uuid, jsonb, integer) to authenticated;

-- 9. Reading the bracket ------------------------------------------------------------------------
-- What the entrant screen reads (the shape guild-event-tournament-panel.jsx documents): kind, rounds,
-- entriesClosed, currentRound, roundDeadlines, bracket, myMatch, podium. Only an entrant, the hosting
-- guild's owner or an Inkroot admin gets an answer; anyone else gets null. An opponent's score is
-- never in it until the match is decided, and tab-switch counts are never in it at all.
create or replace function get_my_tournament_state(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_event guild_events%rowtype;
  v_t guild_event_tournaments%rowtype;
  v_entrant boolean;
  v_bracket jsonb;
  v_my jsonb := null;
  v_podium jsonb := null;
  v_m guild_event_tournament_matches%rowtype;
  v_side text;
  v_opp uuid;
  v_status text;
  v_mine_submitted timestamptz;
  v_total integer;
begin
  if v_uid is null then
    return null;
  end if;
  select * into v_event from guild_events e where e.id = p_event_id;
  if not found or v_event.host <> 'guild' or v_event.event_type <> 'tournament' then
    return null;
  end if;
  select * into v_t from guild_event_tournaments t where t.event_id = p_event_id;
  if not found then
    return null;
  end if;
  v_entrant := exists (
    select 1 from guild_event_entries x where x.event_id = p_event_id and x.entrant_id = v_uid and x.status = 'success'
  );
  if not (v_entrant or is_guild_officer(v_event.guild_id) or is_inkroot_admin()) then
    return null;
  end if;

  select coalesce(jsonb_agg(rd.round_json order by rd.round_no), '[]'::jsonb) into v_bracket
  from (
    select x.round as round_no,
           jsonb_agg(jsonb_build_object(
             'id', x.id,
             'a', case when x.player_a is null then null
                       else jsonb_build_object('userId', x.player_a, 'name', guild_tournament_display_name(x.player_a)) end,
             'b', case when x.is_bye then jsonb_build_object('bye', true)
                       when x.player_b is null then null
                       else jsonb_build_object('userId', x.player_b, 'name', guild_tournament_display_name(x.player_b)) end,
             'winnerId', case when x.status = 'resolved' then x.winner_id else null end
           ) order by x.slot) as round_json
    from guild_event_tournament_matches x
    where x.event_id = p_event_id
    group by x.round
  ) rd;

  -- The caller's own latest match (a player only ever has one live match at a time).
  select * into v_m from guild_event_tournament_matches x
  where x.event_id = p_event_id and (x.player_a = v_uid or x.player_b = v_uid)
  order by x.round desc limit 1;
  if found then
    v_side := case when v_m.player_a = v_uid then 'a' else 'b' end;
    v_opp := case when v_side = 'a' then v_m.player_b else v_m.player_a end;
    v_mine_submitted := case when v_side = 'a' then v_m.a_submitted_at else v_m.b_submitted_at end;
    v_status := case
      when v_m.is_bye then 'bye'
      when v_m.status = 'resolved' and v_m.winner_id = v_uid then 'won'
      when v_m.status = 'resolved' then 'lost'
      when v_mine_submitted is not null then 'submitted'
      else 'awaiting' end;
    v_my := jsonb_build_object(
      'id', v_m.id, 'round', v_m.round, 'status', v_status,
      'opponent', case when v_opp is null then null
                       else jsonb_build_object('name', guild_tournament_display_name(v_opp)) end,
      'deadline', v_m.deadline_at,
      'started', (case when v_side = 'a' then v_m.a_started_at else v_m.b_started_at end) is not null
    );
    select count(*)::integer into v_total from guild_event_tournament_match_questions mq where mq.match_id = v_m.id;
    if v_mine_submitted is not null then
      v_my := v_my || jsonb_build_object(
        'total', v_total,
        'myScore', case when v_side = 'a' then v_m.a_score else v_m.b_score end);
    end if;
    -- The opponent's numbers appear only once the match is decided, and only if they played.
    if v_m.status = 'resolved' and v_m.a_submitted_at is not null and v_m.b_submitted_at is not null then
      v_my := v_my || jsonb_build_object(
        'opponentScore', case when v_side = 'a' then v_m.b_score else v_m.a_score end,
        'decidedBy', v_m.decided_by);
    end if;
  end if;

  if v_t.status = 'finished' then
    v_podium := jsonb_build_object(
      'first', case when v_t.champion_id is null then null
                    else jsonb_build_object('userId', v_t.champion_id, 'name', guild_tournament_display_name(v_t.champion_id)) end,
      'second', case when v_t.runner_up_id is null then null
                     else jsonb_build_object('userId', v_t.runner_up_id, 'name', guild_tournament_display_name(v_t.runner_up_id)) end,
      'third', case when v_t.third_id is null then null
                    else jsonb_build_object('userId', v_t.third_id, 'name', guild_tournament_display_name(v_t.third_id)) end
    );
  end if;

  return jsonb_build_object(
    'kind', 'reading',
    'status', v_t.status,
    'rounds', v_t.rounds,
    'bracketRounds', v_t.bracket_rounds,
    'bracketSize', v_t.bracket_size,
    'entriesClosed', v_t.status <> 'entries_open',
    'currentRound', v_t.current_round,
    'roundDeadlines', v_t.round_deadlines,
    'bracket', v_bracket,
    'myMatch', v_my,
    'podium', v_podium
  );
end;
$$;
revoke all on function get_my_tournament_state(uuid) from public, anon;
grant execute on function get_my_tournament_state(uuid) to authenticated;

-- Tab-switch counts: the hosting guild's owner and Inkroot admins only. A review signal, never an
-- automatic disqualification — nothing in the bracket reads these numbers.
create or replace function list_flagged_tournament_attempts(p_event_id uuid, p_min_switches integer default 1)
returns table (
  match_id uuid, match_round integer, player_id uuid, player_name text, tab_switches integer,
  correct_count integer, time_ms integer, submitted_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  select * into v_event from guild_events e where e.id = p_event_id;
  if not found or v_event.event_type <> 'tournament' then
    raise exception 'Tournament not found.';
  end if;
  if not (is_guild_officer(v_event.guild_id) or is_inkroot_admin()) then
    raise exception 'Only the guild owner or Inkroot can see these.';
  end if;
  return query
    select s.mid, s.rnd, s.pid, guild_tournament_display_name(s.pid), s.tabs, s.correct, s.ms, s.at_time
    from (
      select mt.id as mid, mt.round as rnd, mt.player_a as pid, mt.a_tab_switches as tabs,
             mt.a_score as correct, mt.a_elapsed_ms as ms, mt.a_submitted_at as at_time
      from guild_event_tournament_matches mt
      where mt.event_id = p_event_id and mt.a_submitted_at is not null
      union all
      select mt.id, mt.round, mt.player_b, mt.b_tab_switches, mt.b_score, mt.b_elapsed_ms, mt.b_submitted_at
      from guild_event_tournament_matches mt
      where mt.event_id = p_event_id and mt.b_submitted_at is not null
    ) s
    where s.tabs >= greatest(coalesce(p_min_switches, 1), 1)
    order by s.tabs desc, s.rnd, s.at_time;
end;
$$;
revoke all on function list_flagged_tournament_attempts(uuid, integer) from public, anon;
grant execute on function list_flagged_tournament_attempts(uuid, integer) to authenticated;


-- 10. Existing functions with a tournament change (each is its latest definition + the marked patch) --

-- close_guild_event: migration 69's body plus (a) the same 'guild_event_entry' lock the entry function
-- and complete_guild_event() take, so a late paid entry can't land mid-build, and (b) for a tournament,
-- closing entries builds the bracket (guild_tournament_close_entries above).
create or replace function close_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can close entries for this event.';
  end if;

  -- Migration 176: same lock create_guild_event_entry_locked()/cancel_guild_event()/complete_guild_event() take.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found or v_event.status <> 'open' then
    raise exception 'Event not found, not yours, or not open.';
  end if;

  -- Migration 176: closing a tournament's entries locks the bracket and starts round 1.
  if v_event.event_type = 'tournament' and v_event.host = 'guild' then
    perform guild_tournament_close_entries(p_event_id, false);
    select * into v_row from guild_events where id = p_event_id;
    return v_row;
  end if;

  update guild_events set status = 'closed'
  where id = p_event_id and guild_id = p_guild_id and status = 'open'
  returning * into v_row;
  if not found then
    raise exception 'Event not found, not yours, or not open.';
  end if;
  return v_row;
end;
$$;
revoke all on function close_guild_event(uuid, uuid) from public;
grant execute on function close_guild_event(uuid, uuid) to authenticated;

-- complete_guild_event: migration 171's body plus the tournament refusal.
create or replace function complete_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can complete this event.';
  end if;

  -- Migration 137: same lock create_guild_event_entry_locked()/cancel_guild_event()/
  -- settle_guild_event() take before touching guild_events' status/approval_status — an entry
  -- payment already past its own status check can no longer land a beat after this call closes
  -- the event out from under it.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'Only an active event can be marked completed.';
  end if;
  -- Migration 176: a tournament finishes by itself when its final is decided. Completing it by hand
  -- would strand the bracket, so entries are closed with close_guild_event() instead.
  if v_event.event_type = 'tournament' then
    raise exception 'A tournament finishes on its own once its final is decided — close its entries to start it.';
  end if;

  update guild_events set approval_status = 'completed', completed_at = now(), status = 'closed'
  where id = p_event_id
  returning * into v_event;

  -- Migration 171: a giveaway is drawn the moment it is completed. A failed draw (say nobody
  -- eligible entered) must not undo the completion — it can be retried through draw_guild_giveaway().
  if v_event.event_type = 'giveaway' then
    begin
      perform draw_guild_giveaway(p_event_id);
    exception when others then
      raise warning 'Giveaway draw for event % failed: %', p_event_id, sqlerrm;
    end;
    select * into v_event from guild_events where id = p_event_id;
  end if;
  return v_event;
end;
$$;
revoke all on function complete_guild_event(uuid, uuid) from public;
grant execute on function complete_guild_event(uuid, uuid) to authenticated;

-- close_ended_guild_events: migration 171's body plus the tournament branch.
create or replace function close_ended_guild_events()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_count integer := 0;
begin
  -- Same cron-only guard reconcile_referral_grants/reconcile_naira_achievements use: a pg_cron
  -- job has no JWT (auth.role() is NULL), so a direct postgres/supabase_admin session is
  -- accepted too. A signed-in client or the anon key still can't call this.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  for v_event_id in
    select id from guild_events
    where host = 'guild'
      and status = 'open'
      and approval_status = 'active'
      and end_date is not null
      and end_date < now()
  loop
    perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || v_event_id::text));

    -- Migration 176: for a tournament the end date is the ENTRY deadline. Entries close and the bracket
    -- is built (or, with fewer than 2 paid entrants, it ends as 'no_contest') — the event is NOT
    -- completed here; the round resolver completes it after the final. A failure must not stop the sweep.
    if exists (select 1 from guild_events where id = v_event_id and event_type = 'tournament') then
      begin
        perform guild_tournament_close_entries(v_event_id, true);
        v_count := v_count + 1;
      exception when others then
        raise warning 'Closing tournament entries for event % failed: %', v_event_id, sqlerrm;
      end;
      continue;
    end if;

    update guild_events
    set status = 'closed', approval_status = 'completed', completed_at = now()
    where id = v_event_id
      and status = 'open'
      and approval_status = 'active'
      and end_date is not null
      and end_date < now();

    if found then
      v_count := v_count + 1;
      -- Migration 171: a giveaway that just ended is drawn straight away. A failed draw (say nobody
      -- eligible entered) must not stop the sweep — it stays 'completed' and can be retried by
      -- the organizer or an Inkroot admin through draw_guild_giveaway().
      if exists (select 1 from guild_events where id = v_event_id and event_type = 'giveaway') then
        begin
          perform draw_guild_giveaway(v_event_id);
        exception when others then
          raise warning 'Giveaway draw for event % failed: %', v_event_id, sqlerrm;
        end;
      end if;
    end if;
  end loop;

  return v_count;
end;
$$;
revoke all on function close_ended_guild_events() from public, anon, authenticated;

-- apply_guild_event_entry_payment: migration 146's body plus the closed-bracket refusal.
create or replace function apply_guild_event_entry_payment(p_reference text, p_paid_at timestamptz default now())
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_entry guild_event_entries%rowtype;
  v_limit integer;
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  select event_id into v_event_id from guild_event_entries where paystack_reference = p_reference;
  if not found then
    return 'unmatched';
  end if;

  -- Same lock key as create_guild_event_entry_locked() / settle_guild_event(): a late payment can't
  -- slip in between another entrant's limit check and their insert, or land mid-settlement.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || v_event_id::text));

  select * into v_entry from guild_event_entries where paystack_reference = p_reference for update;
  if v_entry.status = 'success' then
    return 'already_applied';
  end if;
  if v_entry.status <> 'pending' then
    return 'not_pending';
  end if;

  -- Migration 176: once a tournament's bracket exists nobody can be added to it. A payment that lands
  -- after that is refused exactly like an over-limit one (the row becomes 'failed' and 'over_limit' is
  -- returned, which makes the webhook alert ops so the money is refunded by hand).
  if exists (
    select 1 from guild_event_tournaments t where t.event_id = v_entry.event_id and t.status <> 'entries_open'
  ) then
    update guild_event_entries set status = 'failed' where id = v_entry.id;
    return 'over_limit';
  end if;

  select participant_limit into v_limit from guild_events where id = v_entry.event_id;

  -- Only an EXPIRED hold needs the limit re-checked: a pending row younger than 30 minutes is still
  -- being counted by create_guild_event_entry_locked(), so it always has its slot.
  if v_limit is not null and v_entry.created_at <= now() - interval '30 minutes' then
    select count(*) into v_count from guild_event_entries
    where event_id = v_entry.event_id
      and id <> v_entry.id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_limit then
      update guild_event_entries set status = 'failed' where id = v_entry.id;
      return 'over_limit';
    end if;
  end if;

  update guild_event_entries set status = 'success', paid_at = p_paid_at where id = v_entry.id;
  return 'success';
end;
$$;
revoke all on function apply_guild_event_entry_payment(text, timestamptz) from public;
revoke all on function apply_guild_event_entry_payment(text, timestamptz) from anon, authenticated;

-- submit_guild_event_submission: migration 175's body plus the tournament refusal.
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
  -- Migration 176: a tournament match is played through start/submit_tournament_match(); a hand-made
  -- submission has no meaning there.
  if v_event.event_type = 'tournament' then
    raise exception 'Tournament matches are played through the tournament itself.';
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

-- compute_guild_event_placements: migration 172's body plus the tournament branch (marked).
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
  v_tourn guild_event_tournaments%rowtype;   -- Migration 176
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

  -- Migration 176: a tournament has no submissions — its result is the finished bracket.
  if v_event.event_type <> 'tournament' and not exists (select 1 from guild_event_submissions where event_id = p_event_id) then
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

  -- ---- Migration 176: a tournament's placements come from its finished bracket ----
  if v_event.event_type = 'tournament' then
    select * into v_tourn from guild_event_tournaments where event_id = p_event_id;
    if not found then
      raise exception 'This tournament has no bracket on file.';
    end if;
    if v_tourn.status = 'no_contest' then
      raise exception 'This tournament ended without a winner, so there is nothing to pay out. Ask Inkroot to cancel it so the escrowed prize goes back to the guild.';
    end if;
    if v_tourn.status <> 'finished' then
      raise exception 'This tournament isn''t finished — placements can only be computed once its final has been decided.';
    end if;

    -- 1st = champion, 2nd = losing finalist, 3rd = the better semifinal loser (only players who actually
    -- played their last match — see guild_tournament_advance()). The host's declared split is scaled
    -- across the places that WERE awarded, so an unawarded 3rd's share is shared out in proportion
    -- rather than dropped onto 1st alone; the floor's remainder goes to 1st, as everywhere else.
    with podium as (
      select 1 as place, v_tourn.champion_id as entrant_id
      union all select 2, v_tourn.runner_up_id
      union all select 3, v_tourn.third_id
    ),
    declared as (
      select p.place, p.entrant_id, (elem->>'share_bps')::integer as declared_bps
      from podium p
      join jsonb_array_elements(v_objective.placement_split_bps) elem
        on (elem->>'place')::integer = p.place
      where p.entrant_id is not null
    ),
    scaled as (
      select d.place, d.entrant_id,
        ((d.declared_bps::bigint * v_pool_bps) / nullif((select sum(declared_bps) from declared), 0))::integer as raw_bps
      from declared d
    ),
    final_shares as (
      select s.place, s.entrant_id,
        s.raw_bps + case when s.place = (select min(place) from scaled)
          then v_pool_bps - (select coalesce(sum(raw_bps), 0) from scaled)
          else 0
        end as share_bps
      from scaled s
    )
    select jsonb_agg(jsonb_build_object(
      'contributor_id', entrant_id, 'place', place, 'share_bps', share_bps
    ) order by place)
    into v_placements
    from final_shares
    where share_bps > 0;
  else
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
  end if;

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

-- list_public_guild_events: migration 174's body plus the tournament summary. Dropped first: new columns.
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
  quiz_source text, quiz_time_limit_seconds integer, quiz_question_count integer,
  tournament_rounds integer, tournament_status text   -- Migration 176
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
        where p.event_id = e.id and q.status = 'approved')::integer,
      -- Migration 176: a tournament's summary (rounds chosen, and where the bracket is).
      (select t.rounds from guild_event_tournaments t where t.event_id = e.id),
      (select t.status from guild_event_tournaments t where t.event_id = e.id)
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


-- 11. Switch the type on, and schedule the round resolver ---------------------------------------
-- The last blocker: guild_event_type_backend_ready('tournament') was false (169/171/172), which made
-- activate_guild_event() refuse to open one. Giveaway, quiz and tournament are all ready now.
create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then true
    when 'reading_challenge' then true
    when 'tournament' then true
    else true
  end;
$$ language sql immutable;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;

-- Every 5 minutes: rounds resolve within minutes of their deadline. (The hourly sweep from 129 stays as is.)
select cron.schedule('resolve-tournament-rounds', '*/5 * * * *', $$select resolve_tournament_rounds();$$);
