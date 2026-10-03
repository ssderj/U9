# Audit fixes applied to this copy (Oct 2, 2026)

Nothing here has been applied to live Supabase. Live is unchanged.

1. `supabase/history/149, 152 (anon grant follow-up), 153 (default privileges), 180 (quiz revoke)` — restored from live.
2. `supabase/schema.sql` — brought back in line with live:
   - `is_inkroot_admin()` (the old repo copy treated a missing user as admin; live already fixed it), `guild_event_entry_count`, `guild_treasury_role`, `create_guild_event_draft` (13-arg), `update_guild_event_draft` (14-arg) and `guild_event_escrow_contribution_shares` now match live.
   - Missing read policy "signed-in readers read platform post comments" added.
   - The revokes from 149/152/153/180 are appended at the end.
   - `draw_guild_giveaway` updated to match the new migration 193 (this one is intentionally AHEAD of live).
   - Literal `\u2014` text in SQL strings replaced with the real em dash, as live has it (schema.sql and history 42, 43, 45, 69, 113).
3. `supabase/history/193_migration_draw_giveaway_client_role_check.sql` — NEW, not applied. Closes the null-uid skip in `draw_guild_giveaway` (apply once).
4. `supabase/functions/paystack-webhook/index.ts` — alert-only `PAYSTACK_AMOUNT_MISMATCH` check. Needs a redeploy to take effect.

Still to do outside this repo: redeploy `paystack-withdraw` (live is an old version), redeploy `download-book`, turn on leaked-password protection in Supabase Auth settings.

## Verification run against live (Oct 2, 2026)
- Functions: 309 of 310 live public functions match schema.sql body-for-body (comments ignored). The one difference is draw_guild_giveaway, which is ahead of live until 193 is applied.
- Tables 95/95, columns 745/745, triggers 62/62, cron jobs 7/7, storage buckets and policies: all match.
- Migrations 102 and up: 87 of 96 match live statement-for-statement. Not identical: 103, 104, 112, 124, 143 (second), 151 (file text differs from what ran live; end state matches schema.sql), 105 (live is only the policy drop, repo adds the guild function fix), 102b (cron schedule, covered by schema.sql). History files were left as they are.
- Not verified: function EXECUTE grants and table grants (no database to rebuild into), constraint names.
