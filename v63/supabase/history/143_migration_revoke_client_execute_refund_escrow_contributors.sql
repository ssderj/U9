-- Internal-only helper (called from cancel_guild_event / admin_cancel_guild_event_dispute, both security definer).
-- schema.sql intends it to be un-granted to clients; Supabase default privileges had granted it to anon/authenticated.
-- (Applied live 2026-09-24 as 20260924012207 "143_revoke_client_execute_refund_escrow_contributors"; file restored from live.)
revoke all on function refund_guild_event_escrow_contributors(uuid) from public, anon, authenticated;
