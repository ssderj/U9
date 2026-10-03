-- 155_migration_player_guild_fireside.sql
--
-- Closes the gap noted in 80_migration_fireside_announcement_officer_gate.sql's own header
-- comment: "No Player Guild branch is added here... Player Guild Fireside posting isn't wired
-- up at all today." src/shell/home-screen.jsx was passing guildId: null into FiresideBoard for
-- every Player Guild, which forces fireside-board.jsx into its local-only mode (posts land in
-- FIRESIDE_KEY device storage, never in this table) — so even once the client passes a real
-- guildId, a real Player Guild member still couldn't INSERT here without this policy change.
-- Founder Guild behavior is completely untouched.
--
-- fireside_posts.guild_id is `text` (a Founder Guild's fixed slug key, or a Player Guild's real
-- uuid stringified) with NO guild_type discriminator column — unlike guild_order_chapters/
-- guild_order_world_entries/guild_order_proposals (migrations 65/81/82), which added that column
-- specifically so their "either guild type" policies could safely gate a guild_id::uuid cast
-- behind `guild_type = 'player' and (...)`. fireside_posts predates that pattern and isn't
-- getting the column here (out of scope for this pass — touch only this one policy). Casting a
-- Founder Guild's text slug (e.g. 'fantasy') straight to uuid inside a plain OR/AND would raise
-- "invalid input syntax for type uuid" on every Founder Guild post, and Postgres does NOT
-- guarantee left-to-right/short-circuit evaluation of AND/OR sub-expressions (only CASE is
-- documented to evaluate in order and skip unreached branches) — see
-- https://www.postgresql.org/docs/current/sql-expressions.html#SYNTAX-EXPRESS-EVAL. So both
-- checks below use CASE, matching the `~`/`!~` regex-guard idiom already used elsewhere in this
-- schema (e.g. 32_migration_naira_payments.sql, 142_migration_unique_profile_names.sql), to
-- confirm guild_id looks like a real uuid *before* ever casting it, instead of relying on
-- unspecified boolean short-circuiting.
--
-- Membership check: a real Founder Guild member (unchanged) OR — only once guild_id matches the
-- uuid shape — a real Player Guild member (player_guild_members row for auth.uid()).
--
-- Announcement gate: extended to match what notice-board.jsx already enforces on the read side
-- (OFFICER_RUNG_THRESHOLD = 4; goRealPlayerRung in guild-order.jsx gives owner=6, treasurer=5,
-- officer=4 — all >= 4): a Player Guild's owner (player_guilds.owner_id) or a member with
-- player_guild_members.role in ('treasurer', 'officer') may post 'announcement'. The existing
-- Founder Guild branch (profiles.is_platform_admin) is left exactly as it was.
--
-- Every other clause — auth.uid() = author_id, not is_banned(auth.uid()) — is byte-for-byte
-- identical to the policy this replaces.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.

drop policy if exists "guild members post to fireside" on fireside_posts;
create policy "guild members post to fireside" on fireside_posts
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and (
      case
        when exists (
          select 1 from founder_guild_members m
          where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
        ) then true
        when fireside_posts.guild_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then false
        else exists (
          select 1 from player_guild_members m
          where m.guild_id = fireside_posts.guild_id::uuid and m.user_id = auth.uid()
        )
      end
    )
    and (
      case
        when category is distinct from 'announcement' then true
        when exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin) then true
        when fireside_posts.guild_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then false
        else (
          exists (
            select 1 from player_guilds g
            where g.id = fireside_posts.guild_id::uuid and g.owner_id = auth.uid()
          )
          or exists (
            select 1 from player_guild_members m
            where m.guild_id = fireside_posts.guild_id::uuid and m.user_id = auth.uid()
              and m.role in ('treasurer', 'officer')
          )
        )
      end
    )
  );
