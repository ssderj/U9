-- 171_migration_giveaway_backend.sql
--
-- The Giveaway event type, end to end, on the rules the app owner confirmed:
--
--   * Free to enter. Every tap is one free ticket — no payment, no work submitted. Limits: 10 taps a
--     minute per person and 100 tickets per person, both enforced here, never by the client.
--   * The prize is the escrowed guaranteed prize (migration 168 already requires one on every guild
--     event). The winner takes 100% of it, paid straight to their withdrawable balance through the
--     168 payout path — no guild leader's approval and no membership needed.
--   * Members of the hosting guild (member, officer or owner) can never enter or win. Checked when
--     tapping AND again at draw time, in case someone joined the guild after tapping.
--   * draw_method: 'weighted_random' (more tickets, better odds) or 'highest_entries' (most tickets
--     wins; a tie goes to whoever reached that count first). Required on a giveaway, locked once the
--     event leaves draft (the draft RPCs only work on drafts).
--   * The draw runs the moment the event is completed — by the owner's Complete button, or by the
--     hourly sweep at the end date (both now draw a giveaway straight away). draw_guild_giveaway() can be re-run by
--     the organizer, a guild authority or an Inkroot admin if an automatic draw failed.
--
-- Also here: entry_fee_kobo may now be 0 for a giveaway; create/update_guild_event_draft take
-- p_draw_method (the old signatures are dropped so the fee check can't be reached through them);
-- cancel_guild_event refuses a giveaway that has ticket holders (they aren't paid entries, so the
-- old "paid entrant" check wouldn't have caught them); a giveaway can't be 'entered' through the
-- paid-entry function; get_my_guild_event_result() now recognises ticket holders; the public listing
-- returns draw_method and counts ticket holders as participants; and the giveaway type is switched
-- on in guild_event_type_backend_ready().
--
-- Still expected of the host on a giveaway: a financial agreement is required to submit an event
-- (migration 48/167). With no entry fees it carries nothing real — set the prize pool to 100%.
-- Not run against a live database. Safe to apply once.

-- 1. Schema ------------------------------------------------------------------------------------
alter table guild_events add column if not exists draw_method text
  check (draw_method is null or draw_method in ('weighted_random', 'highest_entries'));
alter table guild_events drop constraint if exists guild_events_draw_method_only_giveaway;
alter table guild_events add constraint guild_events_draw_method_only_giveaway
  check (draw_method is null or event_type = 'giveaway');

-- A giveaway's entry fee is 0; everything else keeps "positive". Migration 42's guild-vs-Inkroot
-- funding rule is re-added unchanged.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'guild_events'::regclass and contype = 'c'
      and (
        (pg_get_constraintdef(oid) ilike '%entry_fee_kobo > 0%')
        or (pg_get_constraintdef(oid) ilike '%entry_fee_kobo IS NOT NULL%' and pg_get_constraintdef(oid) ilike '%cash_prize_kobo IS NULL%')
      )
  loop
    execute format('alter table guild_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table guild_events
  add constraint guild_events_entry_fee_check
    check (entry_fee_kobo is null or entry_fee_kobo > 0 or (event_type = 'giveaway' and entry_fee_kobo = 0)),
  add constraint guild_events_host_funding_check
    check (
      (host = 'guild' and entry_fee_kobo is not null and cash_prize_kobo is null) or
      (host = 'inkroot' and cash_prize_kobo is not null and entry_fee_kobo is null)
    );

create table if not exists guild_event_tickets (
  event_id uuid not null references guild_events(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ticket_count integer not null check (ticket_count >= 1 and ticket_count <= 100),
  updated_at timestamptz not null default now(),
  primary key (event_id, user_id)
);
alter table guild_event_tickets enable row level security;
drop policy if exists "entrants read their own giveaway tickets" on guild_event_tickets;
create policy "entrants read their own giveaway tickets" on guild_event_tickets
  for select using (user_id = auth.uid());
-- No insert/update/delete policy: tickets are only ever written by add_giveaway_ticket().
create index if not exists guild_event_tickets_event_idx on guild_event_tickets (event_id);

-- One row per drawn giveaway, for audit. No policies: read with the SQL editor / service role.
create table if not exists guild_event_giveaway_draws (
  event_id uuid primary key references guild_events(id) on delete cascade,
  winner_id uuid not null references auth.users(id) on delete restrict,
  method text not null,
  eligible_entrants integer not null,
  eligible_tickets integer not null,
  winner_tickets integer not null,
  drawn_at timestamptz not null default now()
);
alter table guild_event_giveaway_draws enable row level security;

create or replace function guild_giveaway_ticket_cap()
returns integer as $$ select 100; $$ language sql immutable;
revoke all on function guild_giveaway_ticket_cap() from public, anon, authenticated;

-- The giveaway type is now ready to open; quiz and tournament still aren't.
create or replace function guild_event_type_backend_ready(p_event_type text)
returns boolean as $$
  select case p_event_type
    when 'giveaway' then true
    when 'reading_challenge' then false
    when 'tournament' then false
    else true
  end;
$$ language sql immutable;
revoke all on function guild_event_type_backend_ready(text) from public, anon, authenticated;

-- 2. Rate limit: 10 taps a minute (migration 101's function plus one case) -----------------------
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

-- 3. Draft RPCs take p_draw_method; a giveaway's entry fee is 0 -----------------------------------
drop function if exists create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer);
drop function if exists update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer);

create or replace function create_guild_event_draft(
  p_guild_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null,
  p_min_word_count integer default null,
  p_max_word_count integer default null,
  p_draw_method text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
  v_fee bigint;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can host a guild event.');
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  -- Migration 171: a giveaway is free to enter and has no participant limit; every other type still
  -- needs a positive fee. draw_method is required for a giveaway and meaningless for anything else.
  if coalesce(p_event_type, 'other') = 'giveaway' then
    v_fee := 0;
    if p_draw_method is null or p_draw_method not in ('weighted_random', 'highest_entries') then
      raise exception 'Choose how the giveaway winner is drawn.';
    end if;
  else
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    v_fee := p_entry_fee_kobo;
    if p_draw_method is not null then
      raise exception 'A draw method only applies to a giveaway.';
    end if;
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: the event's own stated start can't already be in the past.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  -- Migration 166: a word range only ever means something for a writing contest.
  if (p_min_word_count is not null or p_max_word_count is not null) and coalesce(p_event_type, 'other') <> 'writing_contest' then
    raise exception 'A word range can only be set on a writing contest.';
  end if;
  if p_min_word_count is not null and p_max_word_count is not null and p_min_word_count > p_max_word_count then
    raise exception 'Minimum word count can''t be higher than the maximum.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status, guaranteed_prize_kobo, min_word_count, max_word_count, draw_method
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    v_fee, case when coalesce(p_event_type, 'other') = 'giveaway' then null else p_participant_limit end, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed', p_guaranteed_prize_kobo, p_min_word_count, p_max_word_count, p_draw_method
  ) returning * into v_row;
  return v_row;
end;
$$;
revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer, text) from public;
grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer, text) to authenticated;

create or replace function update_guild_event_draft(
  p_guild_id uuid,
  p_event_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null,
  p_min_word_count integer default null,
  p_max_word_count integer default null,
  p_draw_method text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_fee bigint;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can edit this event.');
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Only a draft or rejected event can be edited.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  -- Migration 171: a giveaway is free to enter and has no participant limit; every other type still
  -- needs a positive fee. draw_method is required for a giveaway and meaningless for anything else.
  if coalesce(p_event_type, 'other') = 'giveaway' then
    v_fee := 0;
    if p_draw_method is null or p_draw_method not in ('weighted_random', 'highest_entries') then
      raise exception 'Choose how the giveaway winner is drawn.';
    end if;
  else
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    v_fee := p_entry_fee_kobo;
    if p_draw_method is not null then
      raise exception 'A draw method only applies to a giveaway.';
    end if;
  end if;
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: same past-start-date check as create_guild_event_draft above — an edit can
  -- just as easily set (or leave) a stale date as a first save can.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  -- Migration 166: same word-range checks as create_guild_event_draft above.
  if (p_min_word_count is not null or p_max_word_count is not null) and coalesce(p_event_type, 'other') <> 'writing_contest' then
    raise exception 'A word range can only be set on a writing contest.';
  end if;
  if p_min_word_count is not null and p_max_word_count is not null and p_min_word_count > p_max_word_count then
    raise exception 'Minimum word count can''t be higher than the maximum.';
  end if;

  update guild_events set
    title = trim(p_title),
    description = nullif(trim(coalesce(p_description, '')), ''),
    rules = nullif(trim(coalesce(p_rules, '')), ''),
    event_type = coalesce(p_event_type, 'other'),
    entry_fee_kobo = v_fee,
    participant_limit = case when coalesce(p_event_type, 'other') = 'giveaway' then null else p_participant_limit end,
    prize_structure = coalesce(p_prize_structure, '[]'::jsonb),
    guild_share_bps = coalesce(p_guild_share_bps, 0),
    start_date = p_start_date,
    end_date = p_end_date,
    organizer_id = p_organizer_id,
    cover_image_url = p_cover_image_url,
    guaranteed_prize_kobo = p_guaranteed_prize_kobo,
    min_word_count = p_min_word_count,
    max_word_count = p_max_word_count,
    draw_method = p_draw_method,
    approval_status = 'draft',
    rejection_reason = null,
    reviewed_by = null,
    reviewed_at = null,
    submitted_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer, text) from public;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint, integer, integer, text) to authenticated;

-- 4. Tapping for tickets -----------------------------------------------------------------------
create or replace function add_giveaway_ticket(p_event_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'Sign in to enter this giveaway.';
  end if;

  -- Counted first, before any other lookup. (Audit note: a refused tap raises, and that rolls this
  -- bump back with the rest of the transaction — so it is successful taps that fill the 10-a-minute
  -- window, which is what the limit is for. Refused taps are cheap read-only calls.)
  perform check_and_bump_rate_limit('giveaway_tap');

  -- A shared lock: many people can tap at once, but complete_guild_event() and the hourly sweep take
  -- this same key exclusively, so a tap can't land a beat after the event closes underneath it.
  perform pg_advisory_xact_lock_shared(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.event_type <> 'giveaway' or v_event.host <> 'guild' then
    raise exception 'Giveaway not found.';
  end if;
  if v_event.approval_status <> 'active' or v_event.status <> 'open' then
    raise exception 'This giveaway is not taking entries.';
  end if;
  if v_event.start_date is not null and now() < v_event.start_date then
    raise exception 'This giveaway hasn''t started yet.';
  end if;
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This giveaway has ended.';
  end if;

  if is_linked_profile(auth.uid()) then
    raise exception 'Linked profiles can''t enter Guild Events.';
  end if;
  if is_banned(auth.uid()) then
    raise exception 'This account can''t enter giveaways.';
  end if;
  if exists (select 1 from player_guild_members m where m.guild_id = v_event.guild_id and m.user_id = auth.uid())
     or exists (select 1 from player_guilds g where g.id = v_event.guild_id and g.owner_id = auth.uid()) then
    raise exception 'Members of the hosting guild can''t enter their own guild''s giveaway.';
  end if;

  -- One atomic statement: add a ticket unless the person is already at the cap. No row back = capped.
  insert into guild_event_tickets as t (event_id, user_id, ticket_count)
  values (p_event_id, auth.uid(), 1)
  on conflict (event_id, user_id) do update
    set ticket_count = t.ticket_count + 1, updated_at = now()
    where t.ticket_count < guild_giveaway_ticket_cap()
  returning t.ticket_count into v_count;
  if v_count is null then
    raise exception 'You''ve reached the % ticket limit for this giveaway.', guild_giveaway_ticket_cap();
  end if;
  return v_count;
end;
$$;
revoke all on function add_giveaway_ticket(uuid) from public, anon;
grant execute on function add_giveaway_ticket(uuid) to authenticated;

create or replace function get_my_giveaway_tickets(p_event_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then null
    else coalesce((select ticket_count from guild_event_tickets where event_id = p_event_id and user_id = auth.uid()), 0) end;
$$;
revoke all on function get_my_giveaway_tickets(uuid) from public, anon;
grant execute on function get_my_giveaway_tickets(uuid) to authenticated;

-- 5. The draw ----------------------------------------------------------------------------------
-- Who can win: holds tickets, isn't (any longer) in the hosting guild, isn't banned, isn't a linked
-- profile. One definition, used for every number the draw reports and for picking the winner.
-- (Audit fix: the original draft copied these rows into a per-call temporary table. A plain
-- function needs no DDL at draw time, no reliance on pg_temp name resolution inside a security
-- definer function, and is safe to call any number of times in one transaction.)
create or replace function guild_giveaway_eligible(p_event_id uuid, p_guild_id uuid)
returns table (user_id uuid, tickets integer, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.user_id, t.ticket_count, t.updated_at
  from guild_event_tickets t
  where t.event_id = p_event_id
    and not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = t.user_id)
    and not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = t.user_id)
    and not is_banned(t.user_id)
    and not is_linked_profile(t.user_id);
$$;
revoke all on function guild_giveaway_eligible(uuid, uuid) from public, anon, authenticated;

-- Callable by the event's organizer, a guild authority, an Inkroot admin, or the hourly sweep (no
-- signed-in user). Idempotent: an already-paid giveaway returns its stored result untouched.
create or replace function draw_guild_giveaway(p_event_id uuid)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_results%rowtype;
  v_winner uuid;
  v_winner_tickets integer;
  v_total bigint;
  v_entrants integer;
  v_pick bigint;
  v_bytes bytea;
  v_rand bigint;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found or v_event.event_type <> 'giveaway' or v_event.host <> 'guild' then
    raise exception 'Giveaway not found.';
  end if;

  if auth.uid() is not null and not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_event.guild_id)
    or is_inkroot_admin()
  ) then
    raise exception 'Only this giveaway''s organizer, a guild authority, or Inkroot can draw it.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id;

  if v_event.status = 'cancelled' then
    raise exception 'A cancelled giveaway can''t be drawn.';
  end if;
  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    return v_row; -- already drawn and paid
  end if;
  if v_event.approval_status <> 'completed' then
    raise exception 'Complete the giveaway before drawing it.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This giveaway has already been settled.';
  end if;
  if v_event.draw_method is null then
    raise exception 'This giveaway has no draw method on file.';
  end if;
  if v_event.guaranteed_prize_kobo is null or v_event.guaranteed_prize_kobo <= 0 then
    raise exception 'This giveaway has no escrowed prize to pay.';
  end if;

  -- Eligible = see guild_giveaway_eligible() above.
  select coalesce(sum(tickets), 0), count(*) into v_total, v_entrants
  from guild_giveaway_eligible(p_event_id, v_event.guild_id);
  if v_total = 0 then
    raise exception 'Nobody eligible entered this giveaway, so there is no one to draw.';
  end if;

  if v_event.draw_method = 'highest_entries' then
    -- Most tickets wins. A tie goes to whoever reached that count first: a person's count only ever
    -- goes up, so updated_at is exactly when they reached their final count.
    select e.user_id, e.tickets into v_winner, v_winner_tickets
    from guild_giveaway_eligible(p_event_id, v_event.guild_id) e
    order by e.tickets desc, e.updated_at asc, e.user_id
    limit 1;
  else
    -- Weighted random. The random number comes from the database's secure random source (the bytes
    -- of a freshly generated random UUID), never from the client.
    v_bytes := uuid_send(gen_random_uuid());
    v_rand := (get_byte(v_bytes, 0)::bigint << 40) | (get_byte(v_bytes, 1)::bigint << 32)
            | (get_byte(v_bytes, 2)::bigint << 24) | (get_byte(v_bytes, 3)::bigint << 16)
            | (get_byte(v_bytes, 4)::bigint << 8)  |  get_byte(v_bytes, 5)::bigint;
    v_pick := floor(v_total * (v_rand::numeric / 281474976710656))::bigint; -- 0 .. v_total-1
    select w.user_id, w.tickets into v_winner, v_winner_tickets from (
      select gp.user_id, gp.tickets, sum(gp.tickets) over (order by gp.user_id) as running
      from guild_giveaway_eligible(p_event_id, v_event.guild_id) gp
    ) w
    where w.running > v_pick
    order by w.running
    limit 1;
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (
    v_event.guild_id, p_event_id,
    jsonb_build_array(jsonb_build_object('contributor_id', v_winner, 'place', 1, 'share_bps', 10000)),
    'computed', null, now()
  )
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'computed', submitted_by = null, submitted_at = now(),
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;

  -- Paid at once from the escrow, exactly like a judge-free computed event (migration 168/169).
  perform set_config('inkroot.auto_settle_event', p_event_id::text, true);
  perform settle_guild_event(
    v_event.guild_id, p_event_id,
    jsonb_build_array(jsonb_build_object('contributor_id', v_winner, 'share_bps', 10000))
  );
  perform set_config('inkroot.auto_settle_event', '', true);
  update guild_event_results
    set status = 'approved', reviewed_by = null, reviewed_at = now(), settled_at = now()
    where event_id = p_event_id
    returning * into v_row;

  insert into guild_event_giveaway_draws (event_id, winner_id, method, eligible_entrants, eligible_tickets, winner_tickets)
  values (p_event_id, v_winner, v_event.draw_method, v_entrants, v_total::integer, v_winner_tickets)
  on conflict (event_id) do nothing;

  return v_row;
end;
$$;
revoke all on function draw_guild_giveaway(uuid) from public, anon;
grant execute on function draw_guild_giveaway(uuid) to authenticated;

-- 6. Existing functions with a giveaway change (each is its latest definition + the marked patch) --
create or replace function cancel_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_escrow guild_treasury_transactions%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can cancel this event.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'A settled event cannot be cancelled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has already been cancelled.';
  end if;
  if exists (
    select 1 from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'))
  ) then
    raise exception 'This event already has a paid (or still-processing) entrant — it can no longer be cancelled.';
  end if;
  -- Migration 171: a giveaway's entrants hold free tickets, not paid entries — same rule.
  if exists (select 1 from guild_event_tickets where event_id = p_event_id) then
    raise exception 'This giveaway already has entrants — it can no longer be cancelled.';
  end if;

  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
    if v_event.funding_mode = 'contributors' then
      perform refund_guild_event_escrow_contributors(p_event_id);
    else
      select * into v_escrow from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success';
      if found then
        insert into guild_treasury_transactions
          (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
           escrow_event_id, status, title, created_by)
        values
          (p_guild_id, 'guild', null, 'credit', 'event_prize_escrow_release', v_escrow.amount_kobo, 'NGN',
           'event_prize_escrow_held', 'guild_treasury', p_event_id, 'success',
           'Guaranteed prize escrow released (event cancelled) — ' || v_event.title, auth.uid());
      end if;
    end if;
  end if;

  -- Migration 113: an Inkroot-hosted event's reserved prize goes back to the available reserve.
  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid()
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;
revoke all on function cancel_guild_event(uuid, uuid) from public;
grant execute on function cancel_guild_event(uuid, uuid) to authenticated;

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
  if v_event.host <> 'guild' then
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
revoke all on function create_guild_event_entry_locked(uuid, uuid, text, bigint, bigint) from public;

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

drop function if exists list_public_guild_events(integer);
create function list_public_guild_events(p_result_limit integer default null)
returns table (
  id uuid, guild_id uuid, guild_name text, guild_crest_url text,
  host text, title text, description text, event_type text, cover_image_url text,
  entry_fee_kobo bigint, cash_prize_kobo bigint, participant_limit integer,
  start_date timestamptz, end_date timestamptz, approval_status text, status text,
  participant_count integer, collected_net_kobo bigint,
  rules text, guaranteed_prize_kobo bigint, min_word_count integer, max_word_count integer,
  draw_method text
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
      e.draw_method
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

create or replace function get_my_guild_event_result(p_event_id uuid)
returns table (
  event_id uuid, my_place integer, my_share_bps integer, my_amount_kobo bigint, placed_count integer
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_result guild_event_results%rowtype;
  v_mine jsonb;
begin
  if auth.uid() is null then
    return;
  end if;

  -- Only a finished, paid result is ever shown: a 'computed' result on a judged event is still
  -- waiting for Inkroot (migration 169) and can still change.
  select * into v_result from guild_event_results where guild_event_results.event_id = p_event_id and status = 'approved';
  if not found then
    return;
  end if;

  select p into v_mine
  from jsonb_array_elements(v_result.placements) p
  where (p->>'contributor_id')::uuid = auth.uid()
  limit 1;

  -- (Migration 171: a giveaway ticket holder counts as an entrant.) Someone who neither placed nor paid to enter has no business here.
  if v_mine is null and not exists (
    select 1 from guild_event_entries
    where guild_event_entries.event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
  ) and not exists (
    select 1 from guild_event_tickets t
    where t.event_id = p_event_id and t.user_id = auth.uid()
  ) then
    return;
  end if;

  return query
    select p_event_id,
      (v_mine->>'place')::integer,
      (v_mine->>'share_bps')::integer,
      (select pp.amount_kobo from guild_event_prize_payouts pp where pp.event_id = p_event_id and pp.winner_id = auth.uid()),
      jsonb_array_length(v_result.placements);
end;
$$;
revoke all on function get_my_guild_event_result(uuid) from public, anon;
grant execute on function get_my_guild_event_result(uuid) to authenticated;
