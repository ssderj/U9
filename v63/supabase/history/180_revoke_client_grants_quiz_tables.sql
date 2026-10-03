-- Restored from live. Applied to the live database as 20260929083028 "180_revoke_client_grants_quiz_tables".
-- This file was missing from the repo; the SQL below is the statement list Supabase recorded.

revoke all on table guild_quiz_questions, guild_event_quiz_pool, guild_quiz_attempts from anon, authenticated, public;
