-- Migration 190: let a linked profile list its own roster (main + siblings), and close a leak in
-- is_linked_profile().
--
-- WHY (1): linked_profiles' only client read policy is "an account reads its own links"
-- (auth.uid() = main_id or auth.uid() = secondary_id). That lets a secondary see its ONE link to
-- its main, but never the sibling rows (other secondaries under the same main), so the Linked
-- Profiles screen could not offer a switch to a sibling. list_my_linked_profiles() returns the
-- caller's whole roster in one call without widening that policy: it is security definer, takes NO
-- arguments, and derives everything from auth.uid(), so it can only ever describe the caller's
-- own roster, never anyone else's.
--
--   caller is a main      -> relation 'secondary' for each of their secondaries
--   caller is a secondary -> relation 'main' for their main, 'sibling' for every other secondary
--                            under that main
--
-- Names are pen_name, else display_name, else 'Unnamed profile' (same fallback the client used).
-- Nothing here writes anything.
--
-- WHY (2): is_linked_profile(uuid) (163) is security definer and was never revoked from public.
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and Supabase also grants it to
-- anon and authenticated, so any caller could run rpc('is_linked_profile', {check_user_id: <any
-- user id>}) and learn whether that account is a linked profile, which is exactly the link a
-- pseudonymous profile exists to hide. Every caller of it (join_player_guild_by_code,
-- create_or_get_own_guild, create_guild_event_entry_locked, add_giveaway_ticket,
-- guild_giveaway_eligible, enter_official_event_free) is itself security definer, so they keep
-- working after the revoke. Same revoke shape as official_event_placements() in 189.
--
-- ROLLBACK: drop function list_my_linked_profiles(); and, only if you really want the old
-- behaviour back, grant execute on function is_linked_profile(uuid) to authenticated;

create or replace function list_my_linked_profiles()
returns table (id uuid, name text, relation text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select lp.secondary_id,
         coalesce(nullif(p.pen_name, ''), nullif(p.display_name, ''), 'Unnamed profile'),
         'secondary'::text,
         lp.created_at
    from linked_profiles lp
    left join profiles p on p.id = lp.secondary_id
   where lp.main_id = auth.uid()
  union all
  select lp.main_id,
         coalesce(nullif(p.pen_name, ''), nullif(p.display_name, ''), 'Unnamed profile'),
         'main'::text,
         lp.created_at
    from linked_profiles lp
    left join profiles p on p.id = lp.main_id
   where lp.secondary_id = auth.uid()
  union all
  select sib.secondary_id,
         coalesce(nullif(p.pen_name, ''), nullif(p.display_name, ''), 'Unnamed profile'),
         'sibling'::text,
         sib.created_at
    from linked_profiles me
    join linked_profiles sib on sib.main_id = me.main_id and sib.secondary_id <> me.secondary_id
    left join profiles p on p.id = sib.secondary_id
   where me.secondary_id = auth.uid();
$$;

revoke all on function list_my_linked_profiles() from public, anon;
grant execute on function list_my_linked_profiles() to authenticated;

revoke all on function is_linked_profile(uuid) from public, anon, authenticated;
