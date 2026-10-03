-- 185_migration_official_quiz_and_tournament_events.sql
-- ============================================================================================
-- Migration 185: Official Inkroot events — Reading & Trivia quizzes and Tournaments.
--
-- Until now an Inkroot-hosted event (host = 'inkroot') was a bare "cash prize for a guild" row: no
-- event type, no entry, no questions, and its winners had to be members of the guild it was pinned to.
-- Every quiz and tournament function is written for host = 'guild' with a PAID entry, so an official
-- event could not play a quiz at all, even though the official question bank (179) already existed.
--
-- Product rules this migration implements:
--   * Everyone on Inkroot can play. The event is pinned to the General Writers Guild only because
--     guild_events.guild_id is NOT NULL; the host-guild-member exclusion (169) applies to host = 'guild'
--     only, so nobody is shut out by it.
--   * Free unless the admin sets an entry fee. A free entry is a guild_event_entries row with
--     amount_kobo = 0 (see section 1). A paid entry goes through the same Paystack flow as a guild event.
--   * The prize comes from the Inkroot prize reserve (113), reserved when the event is created.
--     Entry fees, when there are any, stay with Inkroot and are not added to the prize.
--   * Winners are picked exactly as for guild events: quiz = score high to low, then fastest server-
--     measured time; tournament = champion, losing finalist, better semifinal loser (only if they played).
--     Prizes are paid straight into each winner's withdrawable balance (guild_event_prize_payouts), so
--     winners do not need to belong to any guild.
--   * Inkroot admins cannot enter or play official events (they write the questions).
--   * An admin picks the questions for each event from the approved official bank, within the same
--     limits as guild events: quiz 15-40, tournament 15-50 (guild_quiz_min_questions() etc.).
--   * Official events are created open in ONE step (admin_create_official_event) so the pool, the
--     settings, the judge-free config and the prize reservation can never be half done.
--
-- Deliberately unchanged: guild-hosted events, the official question bank functions, the tournament
-- engine (bracket, rounds, byes, no-show rules) and the quiz grading — all reused as they are.
--
-- IMPORTANT (found while planning this): guild_event_entries used to be "paid entries only", and three
-- reward gates read it that way (the Inkroot Official badge, its status function, and the Naira welcome
-- reward). A free official entry would have satisfied all three. Section 2 makes each of them count only
-- entries with amount_kobo > 0.
--
-- Not run against a live database (none available when written). Needs 184. Safe to apply once; every
-- function is create-or-replace and every constraint is dropped and re-added by definition.
-- ============================================================================================

-- 1. Schema ------------------------------------------------------------------------------------------

-- The one guild every official event is pinned to (The General Writers Guild, seeded in schema phase 9).
-- Internal: only security-definer functions call it.
create or replace function inkroot_official_guild_id()
returns uuid as $$ select '00000000-f01d-4000-8000-00000000000a'::uuid; $$ language sql immutable;
revoke all on function inkroot_official_guild_id() from public, anon, authenticated;

-- An Inkroot-hosted event may now carry an entry fee (still always a cash prize). Guild-hosted rule unchanged.
alter table guild_events drop constraint if exists guild_events_host_funding_check;
alter table guild_events add constraint guild_events_host_funding_check
  check (
    (host = 'guild' and entry_fee_kobo is not null and cash_prize_kobo is null) or
    (host = 'inkroot' and cash_prize_kobo is not null and (entry_fee_kobo is null or entry_fee_kobo > 0))
  );

-- A free official entry is a row with amount_kobo = 0. Only those rows (recognisable by their reference)
-- may be zero; every paid path still has to carry a real amount.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'guild_event_entries'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%amount_kobo > 0%'
  loop
    execute format('alter table guild_event_entries drop constraint %I', c.conname);
  end loop;
end $$;
alter table guild_event_entries drop constraint if exists guild_event_entries_amount_kobo_nonneg;
alter table guild_event_entries add constraint guild_event_entries_amount_kobo_nonneg
  check (amount_kobo >= 0);
alter table guild_event_entries drop constraint if exists guild_event_entries_zero_amount_only_free;
alter table guild_event_entries add constraint guild_event_entries_zero_amount_only_free
  check (amount_kobo > 0 or paystack_reference like 'free\_entry\_%');

-- True for an Inkroot platform admin. Internal: used by the entry, quiz and match functions below.
create or replace function official_event_admin_blocked(p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select p_user_id is not null
    and exists (select 1 from profiles p where p.id = p_user_id and p.is_platform_admin);
$$;
revoke all on function official_event_admin_blocked(uuid) from public, anon, authenticated;

-- 2. Reward gates: a FREE entry must not count as "paid event participation" --------------------------
-- inkroot_official_badge_earned: requires a PAID entry (amount_kobo > 0).
create or replace function inkroot_official_badge_earned()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    (
      exists (select 1 from purchases where buyer_id = auth.uid() and status = 'success')
      or exists (select 1 from published_books where author_id = auth.uid())
      or exists (select 1 from guild_published_books where author_id = auth.uid())
    )
    and (
      exists (select 1 from founder_guild_members where user_id = auth.uid())
      or exists (select 1 from player_guild_members where user_id = auth.uid())
    )
    and exists (select 1 from guild_event_entries where entrant_id = auth.uid() and status = 'success' and amount_kobo > 0)
    and exists (select 1 from auth.users where id = auth.uid() and created_at <= now() - interval '7 days');
$$;
-- inkroot_official_badge_status: same rule for its paid_event flag.
create or replace function inkroot_official_badge_status()
returns table (has_book boolean, in_guild boolean, paid_event boolean, week_old boolean, earned boolean)
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from purchases where buyer_id = auth.uid() and status = 'success')
      or exists (select 1 from published_books where author_id = auth.uid())
      or exists (select 1 from guild_published_books where author_id = auth.uid()),
    exists (select 1 from founder_guild_members where user_id = auth.uid())
      or exists (select 1 from player_guild_members where user_id = auth.uid()),
    exists (select 1 from guild_event_entries where entrant_id = auth.uid() and status = 'success' and amount_kobo > 0),
    exists (select 1 from auth.users where id = auth.uid() and created_at <= now() - interval '7 days'),
    inkroot_official_badge_earned();
$$;
-- naira_welcome_profile_signals_met: same rule for the welcome reward's event signal.
create or replace function naira_welcome_profile_signals_met()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    coalesce(nullif(trim(p.pen_name), ''), null) is not null
    and coalesce(nullif(trim(p.avatar_url), ''), null) is not null
    and coalesce(nullif(trim(p.motto), ''), null) is not null
    and exists (
      select 1 from player_guild_members m where m.user_id = auth.uid()
      union all
      select 1 from founder_guild_members m where m.user_id = auth.uid()
    )
    and (select count(distinct followee_id) from follows where follower_id = auth.uid()) >= 3
    and exists (
      select 1 from guild_event_entries e where e.entrant_id = auth.uid() and e.status = 'success' and e.amount_kobo > 0
    )
  from profiles p where p.id = auth.uid();
$$;

-- 3. Entry ----------------------------------------------------------------------------------------------

-- Paid entry (service_role only, called by paystack-init-event-entry): an official event with an entry fee
-- is now accepted; the hosting-guild-member exclusion applies to guild-hosted events only; admins are refused.
create or replace function create_guild_event_entry_locked(
  p_user_id uuid, p_event_id uuid, p_paystack_reference text, p_amount_kobo bigint, p_net_kobo bigint
)
returns guild_event_entries
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_entries%rowtype;
  v_row guild_event_entries;
  v_count integer;
  v_had_existing boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  if is_linked_profile(p_user_id) then
    raise exception 'Linked profiles can''t enter Guild Events.';
  end if;

  -- Migration 169: nobody who belongs to the hosting guild (member, officer or owner) may ever enter
  -- its events — the guild is the one paying the prize. Linked profiles are already refused above,
  -- so an alt can't be used to get around this.
  if exists (
    select 1 from guild_events e
    where e.id = p_event_id
      and e.host = 'guild'   -- Migration 185: an official event has no hosting guild to exclude
      and (
        exists (select 1 from player_guild_members m where m.guild_id = e.guild_id and m.user_id = p_user_id)
        or exists (select 1 from player_guilds g where g.id = e.guild_id and g.owner_id = p_user_id)
      )
  ) then
    raise exception 'Members of the hosting guild can''t enter their own guild''s events.';
  end if;

  -- Same lock key settle_guild_event() uses for this event — an entry can't be created mid-
  -- settlement, and two simultaneous entry attempts for the same event now fully serialize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Event not found.';
  end if;
  -- Migration 185: an official quiz or tournament can carry an entry fee; admins may not enter it.
  if v_event.host = 'inkroot' then
    if v_event.event_type not in ('reading_challenge', 'tournament') or v_event.entry_fee_kobo is null then
      raise exception 'This event has no entry fee to pay.';
    end if;
    if official_event_admin_blocked(p_user_id) then
      raise exception 'Inkroot admins can''t enter official events.';
    end if;
  elsif v_event.host <> 'guild' then
    raise exception 'This event has no entry fee to pay.';
  end if;
  if v_event.event_type = 'giveaway' then
    raise exception 'A giveaway is entered by tapping for tickets, not by paying.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'This event is no longer taking entries.';
  end if;
  -- Migration 129: a hard stop independent of status/approval_status, which only get flipped by
  -- complete_guild_event() (manual) or close_ended_guild_events() (hourly cron) — neither of
  -- which is instantaneous with the clock ticking past end_date.
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This event''s entry period has ended.';
  end if;

  select * into v_existing from guild_event_entries
  where event_id = p_event_id and entrant_id = p_user_id;
  -- FOUND is reset by every later SELECT INTO (the participant-limit count below), so it is
  -- captured here instead of being re-read further down.
  v_had_existing := found;

  if v_had_existing and v_existing.status not in ('pending', 'failed') then
    raise exception 'You''ve already entered this event.';
  end if;

  -- Their own unfinished checkout: same slot, new reference. No limit check — they already hold it.
  if v_had_existing and v_existing.status = 'pending' then
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, created_at = now()
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  if v_had_existing then
    -- A previously failed attempt: re-open it rather than violating unique (event_id, entrant_id).
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, status = 'pending', created_at = now(), paid_at = null
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status)
  values (p_event_id, p_user_id, p_paystack_reference, p_amount_kobo, p_net_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

-- Free entry: one tap, one row. Idempotent — entering twice just returns 'success' again.
create or replace function enter_official_event_free(p_event_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_event guild_events%rowtype;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Sign in to enter.';
  end if;
  if is_banned(v_uid) then
    raise exception 'This account can''t enter events.';
  end if;
  if is_linked_profile(v_uid) then
    raise exception 'Linked profiles can''t enter Guild Events.';
  end if;
  if official_event_admin_blocked(v_uid) then
    raise exception 'Inkroot admins can''t enter official events.';
  end if;

  -- Same lock create_guild_event_entry_locked() / settlement / cancellation take for this event.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.host <> 'inkroot' or v_event.event_type not in ('reading_challenge', 'tournament') then
    raise exception 'Event not found.';
  end if;
  if v_event.entry_fee_kobo is not null then
    raise exception 'This event has an entry fee — enter it by paying.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'This event is no longer taking entries.';
  end if;
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This event''s entry period has ended.';
  end if;
  if exists (
    select 1 from guild_event_tournaments t where t.event_id = p_event_id and t.status <> 'entries_open'
  ) then
    raise exception 'Entries for this tournament have closed.';
  end if;

  if exists (
    select 1 from guild_event_entries where event_id = p_event_id and entrant_id = v_uid and status = 'success'
  ) then
    return 'success';
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  -- (A stale 'failed'/'pending' row cannot exist for a free event: nobody ever pays for one.)
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, paid_at)
  values (p_event_id, v_uid, 'free_entry_' || gen_random_uuid()::text, 0, 0, 'success', now());
  return 'success';
end;
$$;
revoke all on function enter_official_event_free(uuid) from public, anon;
grant execute on function enter_official_event_free(uuid) to authenticated;

-- 4. Who may not enter or play: Inkroot admins (they write the questions and see the answer keys) --------
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
  -- Migration 185: an official event has no guild owner/officers; its reviewers are the Inkroot admins.
  if found and v_event.host = 'inkroot' then
    if official_event_admin_blocked(new.entrant_id) then
      raise exception 'Inkroot admins can''t enter official events.';
    end if;
  elsif found and v_event.event_type in ('reading_challenge', 'tournament')
     and guild_quiz_is_reviewer(v_event.guild_id, new.entrant_id) then
    raise exception 'The guild owner and officers can''t enter this event.';
  end if;
  return new;
end;
$$;

-- 5. Playing: the quiz and tournament functions accept an official event ---------------------------------
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
  if not found or v_event.host not in ('guild', 'inkroot') or v_event.event_type <> 'reading_challenge'
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
  -- Migration 185: for an official quiz the people who see the keys are the Inkroot admins.
  if v_event.host = 'inkroot' then
    if official_event_admin_blocked(auth.uid()) then
      raise exception 'Inkroot admins can''t take official quizzes.';
    end if;
  elsif guild_quiz_is_reviewer(v_event.guild_id, auth.uid()) then
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
  -- Migration 185: for an official tournament the people who see the keys are the Inkroot admins.
  if v_event.host = 'inkroot' then
    if official_event_admin_blocked(auth.uid()) then
      raise exception 'Inkroot admins can''t play in official tournaments.';
    end if;
  elsif guild_quiz_is_reviewer(v_event.guild_id, auth.uid()) then
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
  if not found or v_event.host not in ('guild', 'inkroot') or v_event.event_type <> 'tournament' then
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

-- 6. The hourly sweep also ends official quizzes and closes official tournaments' entries --------------------
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
    where (host = 'guild' or (host = 'inkroot' and event_type in ('reading_challenge', 'tournament')))   -- Migration 185
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

-- 7. The old manual "Declare winners" path must not be used for an official quiz or tournament -----------------
create or replace function admin_settle_inkroot_event(p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_inkroot_admin() then
    raise exception 'Only a platform admin can settle an Inkroot-hosted event.';
  end if;

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'inkroot' then
    raise exception 'This event is not Inkroot-hosted — settle it through the guild''s own results flow instead.';
  end if;
  -- Migration 185: that path pays a guild's members through its treasury. An official quiz or tournament
  -- pays its computed winners straight from the prize reserve instead.
  if v_event.event_type in ('reading_challenge', 'tournament') then
    raise exception 'An official quiz or tournament pays its winners with admin_settle_official_event().';
  end if;

  v_event := settle_guild_event(v_event.guild_id, p_event_id, p_shares);

  perform record_admin_action('settle_inkroot_event', 'guild_events', v_event.id,
    null, to_jsonb(v_event), v_event.cash_prize_kobo, null);
  return v_event;
end;
$$;

-- 8. Creating an official event: ONE call, so the pool, settings, config and prize reservation are never half done ----

create or replace function admin_create_official_event(
  p_event_type text,                    -- 'reading_challenge' (quiz) or 'tournament'
  p_title text,
  p_description text,
  p_rules text,
  p_cash_prize_kobo bigint,             -- paid from the Inkroot prize reserve
  p_entry_fee_kobo bigint,              -- null = free entry; otherwise > 0 (kept by Inkroot, not added to the prize)
  p_end_date timestamptz,               -- quiz: when it closes; tournament: the entry deadline
  p_placement_split jsonb,              -- [{"place":1,"share_bps":5000}, ...] summing to 10000
  p_question_ids uuid[],                -- approved questions from the official bank
  p_quiz_time_limit_seconds integer,    -- quiz only
  p_tournament_rounds integer,          -- tournament only (4-6)
  p_participant_limit integer           -- optional cap; a tournament is clamped to 2^rounds
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events;
  v_is_tourn boolean := (p_event_type = 'tournament');
  v_min integer;
  v_max integer;
  v_ids uuid[];
  v_good integer;
  v_available bigint;
  v_limit integer;
  v_sum integer;
  v_max_place integer;
begin
  if not is_inkroot_admin() or auth.uid() is null then
    raise exception 'Only an Inkroot admin can create an official event.';
  end if;
  if p_event_type not in ('reading_challenge', 'tournament') then
    raise exception 'An official event is a Reading & Trivia quiz or a Tournament.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 or length(trim(p_title)) > 200 then
    raise exception 'Give the event a title (up to 200 characters).';
  end if;
  if p_cash_prize_kobo is null or p_cash_prize_kobo <= 0 then
    raise exception 'An official event needs a positive cash prize.';
  end if;
  if p_entry_fee_kobo is not null and p_entry_fee_kobo <= 0 then
    raise exception 'The entry fee must be more than zero — leave it empty for a free event.';
  end if;
  if p_end_date is null or p_end_date <= now() then
    raise exception 'Choose an end date in the future.';
  end if;
  if p_end_date > now() + interval '120 days' then
    raise exception 'The end date can''t be more than 120 days away.';
  end if;

  -- Type-specific settings.
  if v_is_tourn then
    if p_tournament_rounds is null or p_tournament_rounds not between 4 and 6 then
      raise exception 'A tournament runs 4 to 6 rounds.';
    end if;
    if p_participant_limit is not null and p_participant_limit < 2 then
      raise exception 'A tournament needs room for at least 2 players.';
    end if;
    v_limit := least(coalesce(p_participant_limit, power(2, p_tournament_rounds)::integer), power(2, p_tournament_rounds)::integer);
    v_min := guild_tournament_min_pool();
    v_max := guild_tournament_question_cap();
    v_max_place := 3;
  else
    if p_quiz_time_limit_seconds is null or p_quiz_time_limit_seconds < 30 or p_quiz_time_limit_seconds > 7200 then
      raise exception 'The time limit must be between 30 seconds and 2 hours.';
    end if;
    if p_participant_limit is not null and p_participant_limit < 2 then
      raise exception 'A quiz needs room for at least 2 players.';
    end if;
    v_limit := p_participant_limit;
    v_min := guild_quiz_min_questions();
    v_max := guild_quiz_question_cap();
    v_max_place := 10;
  end if;

  -- Prize split: same shape and rules as a guild event's, checked here because no host ever fills it in.
  if p_placement_split is null or jsonb_typeof(p_placement_split) <> 'array' or jsonb_array_length(p_placement_split) = 0 then
    raise exception 'Set how the prize is split between places.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_placement_split) e
    where jsonb_typeof(e) <> 'object'
       or (e->>'place') is null or (e->>'share_bps') is null
       or (e->>'place') !~ '^[0-9]+$' or (e->>'share_bps') !~ '^[0-9]+$'
  ) then
    raise exception 'Each prize place needs a place number and a share.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_placement_split) e
    where (e->>'place')::integer not between 1 and v_max_place or (e->>'share_bps')::integer <= 0
  ) then
    raise exception 'Prize places run 1 to % and each share must be more than zero.', v_max_place;
  end if;
  if (select count(distinct (e->>'place')::integer) from jsonb_array_elements(p_placement_split) e)
     <> jsonb_array_length(p_placement_split) then
    raise exception 'A place can only appear once in the prize split.';
  end if;
  if not exists (select 1 from jsonb_array_elements(p_placement_split) e where (e->>'place')::integer = 1) then
    raise exception 'The prize split must include 1st place.';
  end if;
  select sum((e->>'share_bps')::integer) into v_sum from jsonb_array_elements(p_placement_split) e;
  if v_sum <> 10000 then
    raise exception 'The prize shares must add up to exactly 100%%.';
  end if;

  -- Questions: distinct, approved, from the official bank, within the same limits as a guild event.
  select coalesce(array_agg(distinct q), '{}') into v_ids from unnest(coalesce(p_question_ids, '{}')) q;
  if coalesce(array_length(v_ids, 1), 0) <> coalesce(array_length(p_question_ids, 1), 0) then
    raise exception 'The same question was picked twice.';
  end if;
  if coalesce(array_length(v_ids, 1), 0) < v_min then
    raise exception 'Pick at least % questions (you picked %).', v_min, coalesce(array_length(v_ids, 1), 0);
  end if;
  if array_length(v_ids, 1) > v_max then
    raise exception 'Pick at most % questions (you picked %).', v_max, array_length(v_ids, 1);
  end if;
  select count(*) into v_good from guild_quiz_questions q
  where q.id = any(v_ids) and q.scope = 'inkroot' and q.status = 'approved';
  if v_good <> array_length(v_ids, 1) then
    raise exception 'Only approved questions from the official bank can be used.';
  end if;

  -- Reserve the prize (same lock and check create_guild_event() uses for an Inkroot-hosted prize).
  perform pg_advisory_xact_lock(hashtext('platform_reserve'));
  v_available := platform_reserve_available_kobo();
  if p_cash_prize_kobo > v_available then
    raise exception 'Inkroot''s prize reserve can''t cover this prize: ₦% is available and this event needs ₦%. Top up the reserve first.',
      trim(to_char(v_available / 100.0, 'FM999,999,999,990.00')),
      trim(to_char(p_cash_prize_kobo / 100.0, 'FM999,999,999,990.00'));
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, cash_prize_kobo,
    participant_limit, prize_structure, start_date, end_date,
    quiz_source, quiz_time_limit_seconds,
    created_by, approval_status, status, published_at, activated_at
  ) values (
    inkroot_official_guild_id(), 'inkroot', trim(p_title),
    nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_rules, '')), ''),
    p_event_type, p_entry_fee_kobo, p_cash_prize_kobo,
    v_limit, p_placement_split, now(), p_end_date,
    case when v_is_tourn then null else 'none' end,
    case when v_is_tourn then null else p_quiz_time_limit_seconds end,
    auth.uid(), 'active', 'open', now(), now()
  ) returning * into v_event;

  insert into platform_reserve_kobo (kind, amount_kobo, event_id, note, created_by)
  values ('event_prize_reserved', p_cash_prize_kobo, v_event.id, 'Reserved at event creation — ' || left(v_event.title, 200), auth.uid());

  if v_is_tourn then
    insert into guild_event_tournaments (event_id, rounds, source, anthology_id)
    values (v_event.id, p_tournament_rounds, 'none', null);
  end if;

  insert into guild_event_quiz_pool (event_id, question_id, sort_order)
  select v_event.id, u.q, u.n from unnest(v_ids) with ordinality as u(q, n);

  -- Locked judge-free config: the score (or bracket) decides, no judges, weight 100%.
  insert into guild_event_objective_config
    (event_id, guild_id, metric, weight_bps, placement_split_bps, locked, locked_at, created_by)
  values (v_event.id, inkroot_official_guild_id(), guild_event_judge_free_metric(p_event_type), 10000,
          p_placement_split, true, now(), auth.uid());

  perform record_admin_action('create_official_event', 'guild_events', v_event.id,
    null, to_jsonb(v_event), p_cash_prize_kobo, null);
  return v_event;
end;
$$;
revoke all on function admin_create_official_event(text, text, text, text, bigint, bigint, timestamptz, jsonb, uuid[], integer, integer, integer) from public, anon;
grant execute on function admin_create_official_event(text, text, text, text, bigint, bigint, timestamptz, jsonb, uuid[], integer, integer, integer) to authenticated;

-- 9. Closing early ------------------------------------------------------------------------------------

-- Quiz: ends it now. Tournament: closes entries and builds the bracket (or ends it as no-contest under 2 players).
create or replace function admin_close_official_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_events;
begin
  if not is_inkroot_admin() or auth.uid() is null then
    raise exception 'Only an Inkroot admin can close an official event.';
  end if;
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.host <> 'inkroot' or v_event.event_type not in ('reading_challenge', 'tournament')
     or v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'Event not found, not official, or not open.';
  end if;
  if v_event.event_type = 'tournament' then
    perform guild_tournament_close_entries(p_event_id, false);
  else
    update guild_events set status = 'closed', approval_status = 'completed', completed_at = now()
    where id = p_event_id and status = 'open' and approval_status = 'active';
  end if;
  select * into v_row from guild_events where id = p_event_id;
  perform record_admin_action('close_official_event', 'guild_events', p_event_id, to_jsonb(v_event), to_jsonb(v_row), null, null);
  return v_row;
end;
$$;
revoke all on function admin_close_official_event(uuid) from public, anon;
grant execute on function admin_close_official_event(uuid) to authenticated;

-- 10. Winners + payout ---------------------------------------------------------------------------------

-- The placements, worked out exactly as compute_guild_event_placements() does for a guild event, minus
-- the guild-only parts (agreement, member filters). Read-only; the admin settle function calls it.
create or replace function official_event_placements(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_cfg guild_event_objective_config%rowtype;
  v_tourn guild_event_tournaments%rowtype;
  v_placements jsonb;
begin
  select * into v_event from guild_events where id = p_event_id;
  select * into v_cfg from guild_event_objective_config where event_id = p_event_id;
  if not found then
    raise exception 'This event has no prize split on file.';
  end if;

  if v_event.event_type = 'tournament' then
    select * into v_tourn from guild_event_tournaments where event_id = p_event_id;
    if not found then
      raise exception 'This tournament has no settings on file.';
    end if;
    if v_tourn.status = 'no_contest' then
      raise exception 'This tournament ended without a winner, so there is nothing to pay out. Cancel it to release the prize back to the reserve.';
    end if;
    if v_tourn.status <> 'finished' then
      raise exception 'This tournament isn''t finished — placements can only be computed once its final has been decided.';
    end if;
    -- 1st champion, 2nd losing finalist, 3rd the better semifinal loser (only if they played). The declared
    -- split is scaled across the places actually awarded; the floor's remainder goes to the top place.
    with podium as (
      select 1 as place, v_tourn.champion_id as entrant_id
      union all select 2, v_tourn.runner_up_id
      union all select 3, v_tourn.third_id
    ),
    declared as (
      select p.place, p.entrant_id, (elem->>'share_bps')::integer as declared_bps
      from podium p
      join jsonb_array_elements(v_cfg.placement_split_bps) elem on (elem->>'place')::integer = p.place
      where p.entrant_id is not null
    ),
    scaled as (
      select d.place, d.entrant_id,
        ((d.declared_bps::bigint * 10000) / nullif((select sum(declared_bps) from declared), 0))::integer as raw_bps
      from declared d
    ),
    final_shares as (
      select s.place, s.entrant_id,
        s.raw_bps + case when s.place = (select min(place) from scaled)
          then 10000 - (select coalesce(sum(raw_bps), 0) from scaled) else 0 end as share_bps
      from scaled s
    )
    select jsonb_agg(jsonb_build_object('contributor_id', entrant_id, 'place', place, 'share_bps', share_bps) order by place)
    into v_placements from final_shares where share_bps > 0;
  else
    -- Quiz: score (as a percentage) high to low, then the fastest server-measured time, then who finished first.
    with ranked as (
      select a.user_id as entrant_id,
        row_number() over (
          order by (case when a.total > 0 then round(100.0 * a.score / a.total, 2) else 0 end) desc,
                   a.elapsed_ms asc nulls last, a.submitted_at asc
        ) as place
      from guild_quiz_attempts a
      where a.event_id = p_event_id and a.submitted_at is not null
    ),
    awarded as (
      select r.place, r.entrant_id, ((elem->>'share_bps')::integer) as raw_share_bps
      from ranked r
      join jsonb_array_elements(v_cfg.placement_split_bps) elem on (elem->>'place')::integer = r.place
    ),
    final_shares as (
      select a.place, a.entrant_id,
        a.raw_share_bps + case when a.place = (select min(place) from awarded)
          then 10000 - (select coalesce(sum(raw_share_bps), 0) from awarded) else 0 end as share_bps
      from awarded a
    )
    select jsonb_agg(jsonb_build_object('contributor_id', entrant_id, 'place', place, 'share_bps', share_bps) order by place)
    into v_placements from final_shares where share_bps > 0;
  end if;

  if v_placements is null or jsonb_array_length(v_placements) = 0 then
    raise exception 'Nobody has a placement yet — nobody submitted an attempt.';
  end if;
  return v_placements;
end;
$$;
revoke all on function official_event_placements(uuid) from public, anon, authenticated;

-- Pays the winners straight into their withdrawable balances from the prize reserve. Admin only, once the
-- event is over (and, for a tournament, after any flagged attempts have been reviewed — hence manual).
create or replace function admin_settle_official_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_placements jsonb;
  v_row guild_events;
begin
  if not is_inkroot_admin() or auth.uid() is null then
    raise exception 'Only an Inkroot admin can settle an official event.';
  end if;
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id for update;
  if not found or v_event.host <> 'inkroot' or v_event.event_type not in ('reading_challenge', 'tournament') then
    raise exception 'Official event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' or v_event.approval_status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
  end if;
  if v_event.status <> 'closed' or v_event.approval_status <> 'completed' then
    raise exception 'This event isn''t over yet — it can be settled once it has ended.';
  end if;
  if exists (select 1 from guild_event_prize_payouts where event_id = p_event_id) then
    raise exception 'This event has already been paid out.';
  end if;

  v_placements := official_event_placements(p_event_id);

  -- Largest-remainder rounding, the same method settle_guild_event() uses: the payouts add to the prize exactly.
  with shares as (
    select (s->>'contributor_id')::uuid as winner_id, (s->>'share_bps')::integer as share_bps
    from jsonb_array_elements(v_placements) s
    where (s->>'share_bps')::integer > 0
  ),
  amounts as (
    select winner_id,
      floor(v_event.cash_prize_kobo * share_bps::numeric / 10000)::bigint as base,
      (v_event.cash_prize_kobo * share_bps::numeric / 10000) - floor(v_event.cash_prize_kobo * share_bps::numeric / 10000) as frac
    from shares
  ),
  ranked as (
    select winner_id, base,
      row_number() over (order by frac desc, winner_id) as rn,
      (v_event.cash_prize_kobo - sum(base) over ())::bigint as leftover
    from amounts
  )
  insert into guild_event_prize_payouts (event_id, guild_id, winner_id, amount_kobo)
  select p_event_id, v_event.guild_id, winner_id, base + case when rn <= leftover then 1 else 0 end
  from ranked
  where base + case when rn <= leftover then 1 else 0 end > 0;

  perform platform_reserve_record_settlement(p_event_id);

  -- The results row is what entrants read (get_my_guild_event_result) and what fires the "results are in"
  -- notification: created as 'computed'-style pending, then approved in the same transaction.
  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by)
  values (v_event.guild_id, p_event_id, v_placements, 'pending_approval', auth.uid())
  on conflict (event_id) do update set placements = excluded.placements, status = 'pending_approval';
  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_row from guild_events where id = p_event_id;

  perform record_admin_action('settle_official_event', 'guild_events', p_event_id,
    to_jsonb(v_event), to_jsonb(v_row), v_event.cash_prize_kobo, null);
  return v_row;
end;
$$;
revoke all on function admin_settle_official_event(uuid) from public, anon;
grant execute on function admin_settle_official_event(uuid) to authenticated;
