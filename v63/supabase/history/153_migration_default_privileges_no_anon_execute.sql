-- Restored from live. Applied to the live database as 20260925075728 "153_migration_default_privileges_no_anon_execute".
-- This file was missing from the repo; the SQL below is the statement list Supabase recorded.

alter default privileges for role postgres in schema public revoke execute on functions from anon;
