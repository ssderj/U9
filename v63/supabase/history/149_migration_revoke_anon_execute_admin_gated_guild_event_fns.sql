-- Restored from live. Applied to the live database as 20260925074737 "149_migration_revoke_anon_execute_admin_gated_guild_event_fns".
-- This file was missing from the repo; the SQL below is the statement list Supabase recorded.

revoke execute on function admin_cancel_guild_event_dispute(uuid, text) from anon;
revoke execute on function compute_guild_event_placements(uuid, uuid[]) from anon;
