-- 191: one-call anthology card stats for a guild (replaces N per-anthology contributor lookups)
--
-- The Guild Anthologies list used to call guild_anthology_contributors() once per anthology just to
-- show "N contributors" on each card. This returns the same count for every anthology in a guild in a
-- single call, plus the submission count and approved word total so a card can show real totals.
-- Counting matches guild_anthology_contributors(): contributors = approved submissions (see
-- 35_migration_guild_anthologies.sql). Same guard too: only members of the guild can call it.
-- Read-only; no tables or policies change.

create or replace function guild_anthology_card_stats(p_guild_id uuid)
returns table (anthology_id uuid, contributor_count integer, submission_count integer, approved_words bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_guild_member(p_guild_id) then
    raise exception 'Not a member of this guild.';
  end if;
  return query
    select a.id,
           (count(s.id) filter (where s.review_status = 'approved'))::integer,
           (count(s.id) filter (where s.review_status in ('pending', 'approved')))::integer,
           coalesce(sum(s.word_count) filter (where s.review_status = 'approved'), 0)::bigint
    from guild_anthologies a
    left join guild_anthology_submissions s on s.anthology_id = a.id
    where a.guild_id = p_guild_id
    group by a.id;
end;
$$;

revoke all on function guild_anthology_card_stats(uuid) from public, anon;
grant execute on function guild_anthology_card_stats(uuid) to authenticated;
