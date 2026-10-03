-- 170_migration_entrant_results_public_listing_server_word_count.sql
--
-- Three shared fixes the new guild event screens rely on:
--
--   1. WINNERS CAN SEE THEIR OWN RESULT. guild_event_results is readable only by the organizer who
--      submitted it and guild treasury authorities (migration 49), so an entrant — the person the
--      result is about — could never see their own placement. get_my_guild_event_result() returns the
--      caller's place and payout for a finished (paid) event. Nothing about anyone else's payout is
--      returned, only how many people placed.
--   2. THE PUBLIC LISTING RETURNS WHAT THE CARDS NEED. list_public_guild_events() now also returns the
--      event's rules (the detail screen already had a slot waiting for them), its guaranteed prize
--      (since migration 168 that, not collected entry fees, IS the prize), and the writing word
--      range. Fields for the new event types (draw method, quiz book, tournament summary) can't be
--      added yet — those columns arrive with their own migrations, which will extend this list again.
--   3. WORD COUNT IS COUNTED ON THE SERVER. submit_guild_event_submission() took the client's word
--      count on trust, so the range from migration 166 (and the word_count scoring metric) could be
--      beaten by a direct RPC call. It now strips the HTML from content.text itself, counts words the
--      same way the app does (src/shared-utils/strip-html.jsx), and enforces the range on that
--      number. content without text (e.g. a world-building piece or a manuscript link) has no words
--      to count, so its word_count is stored as 0 — never the client's number (audit fix: the
--      original draft kept the client's number here, which let a direct RPC call with a non-text
--      content object claim any word count and win a word_count-scored contest). It is refused
--      outright if the event has a word range.
--
-- Not run against a live database. Safe to apply once; functions are create-or-replace, and the
-- listing function is dropped first because its return columns change.

-- ----------------------------------------------------------------------------------------------
-- 1. Own result
-- ----------------------------------------------------------------------------------------------
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

  -- Someone who neither placed nor paid to enter has no business here.
  if v_mine is null and not exists (
    select 1 from guild_event_entries
    where guild_event_entries.event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
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

-- ----------------------------------------------------------------------------------------------
-- 2. Public listing
-- ----------------------------------------------------------------------------------------------
drop function if exists list_public_guild_events(integer);
create function list_public_guild_events(p_result_limit integer default null)
returns table (
  id uuid, guild_id uuid, guild_name text, guild_crest_url text,
  host text, title text, description text, event_type text, cover_image_url text,
  entry_fee_kobo bigint, cash_prize_kobo bigint, participant_limit integer,
  start_date timestamptz, end_date timestamptz, approval_status text, status text,
  participant_count integer, collected_net_kobo bigint,
  rules text, guaranteed_prize_kobo bigint, min_word_count integer, max_word_count integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select
      e.id, e.guild_id, g.name, g.crest_url,
      e.host, e.title, e.description, e.event_type, e.cover_image_url,
      e.entry_fee_kobo, e.cash_prize_kobo, e.participant_limit,
      e.start_date, e.end_date, e.approval_status, e.status,
      coalesce(c.participant_count, 0)::integer,
      coalesce(c.collected_net_kobo, 0)::bigint,
      e.rules, e.guaranteed_prize_kobo, e.min_word_count, e.max_word_count
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

-- ----------------------------------------------------------------------------------------------
-- 3. Server-side word count
-- ----------------------------------------------------------------------------------------------
-- Mirrors wordCount()/stripHtml() in src/shared-utils/strip-html.jsx: every tag becomes a space,
-- &nbsp; becomes a space, then whitespace-separated tokens are counted. The whitespace class is
-- spelled out to match JavaScript's \s (Postgres's own \s depends on the database locale and can
-- miss a literal no-break space, which would let a writer glue words together to slip under a
-- maximum): space/tab/newline classes plus U+00A0, U+1680, U+2000-200A, U+2028/2029, U+202F,
-- U+205F, U+3000 and U+FEFF. (Audit fix: the original draft used plain \s.)
create or replace function guild_event_count_words(p_html text)
returns integer
language sql immutable set search_path = public as $$
  select coalesce(array_length(array_remove(regexp_split_to_array(
    replace(regexp_replace(coalesce(p_html, ''), '<[^>]+>', ' ', 'g'), '&nbsp;', ' '),
    '[\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'
  ), ''), 1), 0);
$$;
revoke all on function guild_event_count_words(text) from public, anon, authenticated;

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
