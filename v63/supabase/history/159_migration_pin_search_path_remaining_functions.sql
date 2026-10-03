-- Pins search_path on the 12 functions the Supabase security advisor flagged as
-- "Function Search Path Mutable" (lint 0011). No logic change on any of them — this only
-- adds an explicit `set search_path = public` so each function always resolves table/function
-- names against the `public` schema, regardless of the calling session's own search_path.
-- Matches the repo-wide convention already used elsewhere (see
-- 96b_search_path_fix.sql and fix_security_definer_search_path_and_add_rate_limits.sql).
--
-- Applied directly to the live project on 2026-09-26 (via Supabase's migration tooling);
-- this file exists so `supabase/history/` and `schema.sql` in the repo match what's actually
-- live. Fold these 12 statements into schema.sql wherever each function is originally defined,
-- same as every other migration in this history.

alter function public.achievement_min_purchase_kobo() set search_path = public;
alter function public.enforce_platform_post_comment_cooldown() set search_path = public;
alter function public.forbid_admin_audit_log_mutation() set search_path = public;
alter function public.forbid_platform_reserve_mutation() set search_path = public;
alter function public.guild_event_escrow_max_kobo() set search_path = public;
alter function public.guild_event_judge_panel_size() set search_path = public;
alter function public.guild_event_judge_quorum(p_assigned_count integer) set search_path = public;
alter function public.guild_event_placement_split_sum(p jsonb) set search_path = public;
alter function public.guild_treasury_direct_spend_cap_kobo() set search_path = public;
alter function public.is_reserved_guild_name(p_name text) set search_path = public;
alter function public.normalize_guild_identity_name(p_name text) set search_path = public;
alter function public.touch_platform_posts_updated_at() set search_path = public;
