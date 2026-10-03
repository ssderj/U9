# supabase/history/INDEX.md

Index of every numbered migration in this folder. Files are listed as they exist; none were renamed.

**Live version / name columns:** read from live `supabase_migrations.schema_migrations` on Oct 2, 2026. Live uses timestamp versions and its own names. Rows 1-84 were applied to live as bundled `inkroot_schema_part_01..36` / `inkroot_schema_remainder_01..07` (not one-to-one with these files), so those columns are left blank. Rows 91, 96, 97, 98 and 100 have no clear one-to-one live match (blank, not guessed). Live has related entries that may cover them: `inkroot_fix_mutable_search_path`, `inkroot_m96_book_downloadable_flag`, `inkroot_m96b_search_path_fix`, `guild_ranking_leak_fix_and_download_purchase_gate_and_storage_quota`, `inkroot_m98a/m98b_*`, `harden_author_balance_kobo_authorization`; check by content before relying on them. 166, 188, 189 and 193/194 have unnumbered live names and are matched by content. Live applied some numbers out of order (e.g. 124 before 120, 149-151, 155).

## Duplicate numbers

These numbers were each used by two files (written in parallel, or restored from live later). The order below within a number is by file name, not by when it was applied. Always apply by file name, not by number alone.

- **143**: `143_migration_restore_author_balance_reward_terms.sql`, `143_migration_revoke_client_execute_refund_escrow_contributors.sql`
- **152**: `152_migration_anon_grant_audit_followup.sql`, `152_migration_platform_posts.sql`
- **153**: `153_migration_default_privileges_no_anon_execute.sql`, `153_migration_platform_posts_v2.sql`
- **180**: `180_migration_judge_free_place_limits.sql`, `180_revoke_client_grants_quiz_tables.sql`

Other numbers that repeat (letter-suffixed or otherwise): none

## Migrations

| # | File | Name | Live version | Live name |
|---|------|------|--------------|-----------|
| 1 | `01_migration_scrub_author_email_fallback.sql` | scrub author email fallback |  |  |
| 2 | `02_migration_fix_profile_email_seed.sql` | fix profile email seed |  |  |
| 3 | `03_migration_restrict_player_guild_invite_code.sql` | restrict player guild invite code |  |  |
| 4 | `04_migration_bound_guild_member_stats.sql` | bound guild member stats |  |  |
| 5 | `05_migration_guild_member_stats_membership_fk.sql` | guild member stats membership fk |  |  |
| 6 | `06_migration_guard_guild_member_stats_delta.sql` | guard guild member stats delta |  |  |
| 7 | `07_migration_add_guild_book_feedback_update_policy.sql` | add guild book feedback update policy |  |  |
| 8 | `08_migration_founder_guild_membership.sql` | founder guild membership |  |  |
| 9 | `09_migration_scope_project_media_private.sql` | scope project media private |  |  |
| 10 | `10_migration_bound_media_bucket_uploads.sql` | bound media bucket uploads |  |  |
| 11 | `11_migration_tighten_guild_update_policies.sql` | tighten guild update policies |  |  |
| 12 | `12_migration_split_private_media_bucket.sql` | split private media bucket |  |  |
| 13 | `13_migration_server_authoritative_kv_versioning.sql` | server authoritative kv versioning |  |  |
| 14 | `14_migration_drop_denormalized_author_names.sql` | drop denormalized author names |  |  |
| 15 | `15_migration_guard_guild_member_stats_insert.sql` | guard guild member stats insert |  |  |
| 16 | `16_migration_guild_book_feedback_uniqueness.sql` | guild book feedback uniqueness |  |  |
| 17 | `17_migration_kv_store_value_size_cap.sql` | kv store value size cap |  |  |
| 18 | `18_migration_published_books_destination_check.sql` | published books destination check |  |  |
| 19 | `19_migration_dedupe_public_media_folder_list.sql` | dedupe public media folder list |  |  |
| 20 | `20_migration_drop_redundant_guild_indexes.sql` | drop redundant guild indexes |  |  |
| 21 | `21_migration_account_deletion_grace_period.sql` | account deletion grace period |  |  |
| 22 | `22_migration_text_field_length_caps.sql` | text field length caps |  |  |
| 23 | `23_migration_account_deletion_storage_cleanup.sql` | account deletion storage cleanup |  |  |
| 24 | `24_migration_verified_author_badge.sql` | verified author badge |  |  |
| 25 | `25_migration_report_reasons_impersonation_scam.sql` | report reasons impersonation scam |  |  |
| 26 | `26_migration_published_books_richer_metadata.sql` | published books richer metadata |  |  |
| 27 | `27_migration_moderation_queue.sql` | moderation queue |  |  |
| 28 | `28_migration_content_ban.sql` | content ban |  |  |
| 29 | `29_migration_moderator_grants_verified.sql` | moderator grants verified |  |  |
| 30 | `30_migration_login_ban_and_device_signal.sql` | login ban and device signal |  |  |
| 31 | `31_migration_report_accounts_directly.sql` | report accounts directly |  |  |
| 32 | `32_migration_naira_payments.sql` | naira payments |  |  |
| 33 | `33_migration_guild_treasury.sql` | guild treasury |  |  |
| 34 | `34_migration_guild_treasury_ledger_hardening.sql` | guild treasury ledger hardening |  |  |
| 35 | `35_migration_guild_anthologies.sql` | guild anthologies |  |  |
| 36 | `36_migration_guild_anthology_revenue_agreements.sql` | guild anthology revenue agreements |  |  |
| 37 | `37_migration_guild_revenue_distribution.sql` | guild revenue distribution |  |  |
| 38 | `38_migration_rising_star_scoring.sql` | rising star scoring |  |  |
| 39 | `39_migration_best_sellers_most_read.sql` | best sellers most read |  |  |
| 40 | `40_migration_guilds_on_rise_scoring.sql` | guilds on rise scoring |  |  |
| 41 | `41_migration_guild_member_earnings_withdrawal.sql` | guild member earnings withdrawal |  |  |
| 42 | `42_migration_guild_events.sql` | guild events |  |  |
| 43 | `43_migration_inkroot_events_admin.sql` | inkroot events admin |  |  |
| 44 | `44_migration_guild_treasury_roles_and_approvals.sql` | guild treasury roles and approvals |  |  |
| 45 | `45_migration_guild_event_creation_workflow.sql` | guild event creation workflow |  |  |
| 46 | `46_migration_guild_event_entry_count.sql` | guild event entry count |  |  |
| 47 | `47_migration_guild_event_hosting_fee.sql` | guild event hosting fee |  |  |
| 48 | `48_migration_guild_event_financial_agreement.sql` | guild event financial agreement |  |  |
| 49 | `49_migration_guild_event_results_approval.sql` | guild event results approval |  |  |
| 50 | `50_migration_economy_security_audit.sql` | economy security audit |  |  |
| 51 | `51_migration_public_guild_events_directory.sql` | public guild events directory |  |  |
| 52 | `52_migration_naira_achievement_grants.sql` | naira achievement grants |  |  |
| 53 | `53_migration_naira_writing_and_reading_signals.sql` | naira writing and reading signals |  |  |
| 54 | `54_migration_naira_welcome_and_profile_motto.sql` | naira welcome and profile motto |  |  |
| 55 | `55_migration_referral_tracking.sql` | referral tracking |  |  |
| 56 | `56_migration_referral_rewards.sql` | referral rewards |  |  |
| 57 | `57_migration_referral_reward_platform_fee_funding.sql` | referral reward platform fee funding |  |  |
| 58 | `58_migration_referral_reward_limits_and_anti_abuse.sql` | referral reward limits and anti abuse |  |  |
| 59 | `59_migration_referral_reward_progress_reflects_reversals.sql` | referral reward progress reflects reversals |  |  |
| 60 | `60_migration_book_view_analytics.sql` | book view analytics |  |  |
| 61 | `61_migration_reviews_rating_column.sql` | reviews rating column |  |  |
| 62 | `62_migration_manual_withdrawals.sql` | manual withdrawals |  |  |
| 63 | `63_migration_book_view_source_most_read.sql` | book view source most read |  |  |
| 64 | `64_migration_trending.sql` | trending |  |  |
| 65 | `65_migration_guild_order_manuscript.sql` | guild order manuscript |  |  |
| 66 | `66_migration_guild_order_manuscript_realtime.sql` | guild order manuscript realtime |  |  |
| 67 | `67_migration_book_discussion_hall.sql` | book discussion hall |  |  |
| 68 | `68_migration_report_book_discussion_posts.sql` | report book discussion posts |  |  |
| 69 | `69_migration_founder_guild_parity.sql` | founder guild parity |  |  |
| 70 | `70_migration_published_book_content.sql` | published book content |  |  |
| 71 | `71_migration_ban_check_insert_policies.sql` | ban check insert policies |  |  |
| 72 | `72_migration_player_guild_ownership_cap.sql` | player guild ownership cap |  |  |
| 73 | `73_migration_publish_word_count_floor.sql` | publish word count floor |  |  |
| 74 | `74_migration_anthology_publish_word_count_floor.sql` | anthology publish word count floor |  |  |
| 75 | `75_migration_content_reports_rate_limit.sql` | content reports rate limit |  |  |
| 76 | `76_migration_fireside_post_cooldown.sql` | fireside post cooldown |  |  |
| 77 | `77_migration_admin_role_revocation.sql` | admin role revocation |  |  |
| 78 | `78_migration_moderator_content_removal.sql` | moderator content removal |  |  |
| 79 | `79_migration_account_deletion_guild_check.sql` | account deletion guild check |  |  |
| 80 | `80_migration_fireside_announcement_officer_gate.sql` | fireside announcement officer gate |  |  |
| 81 | `81_migration_guild_order_world_bible.sql` | guild order world bible |  |  |
| 82 | `82_migration_guild_order_council.sql` | guild order council |  |  |
| 83 | `83_migration_notifications.sql` | notifications |  |  |
| 84 | `84_migration_living_universe_public_feed.sql` | living universe public feed |  |  |
| 85 | `85_migration_worldbuilding_pack_discovery_and_purchase.sql` | worldbuilding pack discovery and purchase | 20260916231838 | inkroot_m85_worldbuilding_pack_discovery_purchase |
| 86 | `86_migration_addon_marketplace.sql` | addon marketplace | 20260916231846 | inkroot_m86_addon_marketplace |
| 87 | `87_migration_template_marketplace.sql` | template marketplace | 20260916231853 | inkroot_m87_template_marketplace |
| 88 | `88_migration_founder_guild_member_stats.sql` | founder guild member stats | 20260916231901 | inkroot_m88_founder_guild_member_stats |
| 89 | `89_migration_paid_book_content_access.sql` | paid book content access | 20260916231914 | inkroot_m89_paid_book_content_access |
| 90 | `90_migration_guild_book_privacy.sql` | guild book privacy | 20260917043954 | inkroot_m90_guild_book_privacy |
| 91 | `91_migration_anthology_submission_content.sql` | anthology submission content |  |  |
| 92 | `92_migration_player_guild_book_publishing.sql` | player guild book publishing | 20260917044004 | inkroot_m92_player_guild_book_publishing |
| 93 | `93_migration_anthology_guild_shelf.sql` | anthology guild shelf | 20260917044027 | inkroot_m93_anthology_guild_shelf |
| 94 | `94_migration_official_badge_and_checkins.sql` | official badge and checkins | 20260917044049 | inkroot_m94_official_badge_and_checkins |
| 95 | `95_migration_fix_badge_probe.sql` | fix badge probe | 20260917044105 | inkroot_m95_fix_badge_probe |
| 96 | `96_migration_security_audit_fixes.sql` | security audit fixes |  |  |
| 97 | `97_migration_download_purchase_guild_gate_and_storage_quota.sql` | download purchase guild gate and storage quota |  |  |
| 98 | `98_migration_server_side_rate_limits.sql` | server side rate limits |  |  |
| 99 | `99_migration_book_view_input_validation_and_direct_insert_lockdown.sql` | book view input validation and direct insert lockdown | 20260920235658 | inkroot_m99_book_view_input_validation_and_direct_insert_lockdown |
| 100 | `100_migration_author_balance_caller_check.sql` | author balance caller check |  |  |
| 101 | `101_migration_join_guild_rate_limit.sql` | join guild rate limit | 20260921004053 | inkroot_m101_join_guild_rate_limit |
| 102 | `102_migration_reconcile_referral_grants_cron_guard.sql` | reconcile referral grants cron guard | 20260921082359 | 102_reconcile_referral_grants_cron_guard |
| 103 | `103_migration_achievement_signals_paid_books_only.sql` | achievement signals paid books only | 20260921082350 | 103_achievement_signals_paid_books_only |
| 104 | `104_migration_event_entry_retry_after_abandoned_payment.sql` | event entry retry after abandoned payment | 20260921082435 | 104_event_entry_retry_after_abandoned_payment |
| 105 | `105_migration_close_player_guild_join_and_hijack.sql` | close player guild join and hijack | 20260921081756 | 105_close_player_guild_direct_join |
| 106 | `106_migration_purchase_init_race_lock.sql` | purchase init race lock | 20260921095125 | 106_purchase_init_race_lock |
| 107 | `107_migration_achievement_wash_trading_device_check.sql` | achievement wash trading device check | 20260921095141 | 107_achievement_wash_trading_device_check |
| 108 | `108_migration_guild_event_prize_escrow.sql` | guild event prize escrow | 20260921095243 | 108_guild_event_prize_escrow |
| 109 | `109_migration_escrowed_prize_pays_winners_in_full.sql` | escrowed prize pays winners in full | 20260921095305 | 109_escrowed_prize_pays_winners_in_full |
| 110 | `110_migration_achievement_grant_reversals.sql` | achievement grant reversals | 20260921095341 | 110_achievement_grant_reversals |
| 111 | `111_migration_payout_account_cooldown.sql` | payout account cooldown | 20260921095413 | 111_payout_account_cooldown |
| 112 | `112_migration_guild_treasury_spend_limits.sql` | guild treasury spend limits | 20260921095518 | 112_guild_treasury_spend_limits |
| 113 | `113_migration_inkroot_prize_reserve.sql` | inkroot prize reserve | 20260921213004 | 113_migration_inkroot_prize_reserve |
| 114 | `114_migration_admin_audit_log.sql` | admin audit log | 20260921213045 | 114_migration_admin_audit_log |
| 115 | `115_migration_purchase_buyer_not_author.sql` | purchase buyer not author | 20260921213055 | 115_migration_purchase_buyer_not_author |
| 116 | `116_migration_guild_event_escrow_limit.sql` | guild event escrow limit | 20260921213106 | 116_migration_guild_event_escrow_limit |
| 117 | `117_migration_join_guild_banned_check.sql` | join guild banned check | 20260921213115 | 117_migration_join_guild_banned_check |
| 118 | `118_migration_protect_sold_listings_on_unpublish.sql` | protect sold listings on unpublish | 20260921213140 | 118_migration_protect_sold_listings_on_unpublish |
| 119 | `119_migration_follows_no_self_follow.sql` | follows no self follow | 20260921213146 | 119_migration_follows_no_self_follow |
| 120 | `120_migration_guild_event_settlement_hardening.sql` | guild event settlement hardening | 20260923000501 | 120_migration_guild_event_settlement_hardening |
| 121 | `121_migration_guild_event_fair_judging.sql` | guild event fair judging | 20260923011157 | 121_migration_guild_event_fair_judging |
| 122 | `122_migration_founder_guild_no_treasury_or_hosting.sql` | founder guild no treasury or hosting | 20260923011255 | 122_migration_founder_guild_no_treasury_or_hosting |
| 123 | `123_migration_achievement_min_purchase_amount.sql` | achievement min purchase amount | 20260923011310 | 123_migration_achievement_min_purchase_amount |
| 124 | `124_migration_guild_officer_not_found_vs_not_owner.sql` | guild officer not found vs not owner | 20260922201535 | 124_guild_officer_not_found_vs_not_owner |
| 125 | `125_migration_guild_name_dates_escrow_required.sql` | guild name dates escrow required | 20260923011359 | 125_migration_guild_name_dates_escrow_required |
| 126 | `126_migration_guild_creation_hardening.sql` | guild creation hardening | 20260924002251 | 126_migration_guild_creation_hardening |
| 127 | `127_migration_close_guild_event_creation_bypass.sql` | close guild event creation bypass | 20260924002303 | 127_migration_close_guild_event_creation_bypass |
| 128 | `128_migration_guild_event_start_date_not_in_past.sql` | guild event start date not in past | 20260924002330 | 128_migration_guild_event_start_date_not_in_past |
| 129 | `129_migration_guild_event_end_date_enforcement.sql` | guild event end date enforcement | 20260924002348 | 129_migration_guild_event_end_date_enforcement |
| 130 | `130_migration_close_double_escrow_race.sql` | close double escrow race | 20260924002408 | 130_migration_close_double_escrow_race |
| 131 | `131_migration_guild_event_contributor_escrow.sql` | guild event contributor escrow | 20260924002503 | 131_migration_guild_event_contributor_escrow |
| 132 | `132_migration_wire_contributor_escrow_refunds.sql` | wire contributor escrow refunds | 20260924002527 | 132_migration_wire_contributor_escrow_refunds |
| 133 | `133_migration_pay_contributors_debits_treasury.sql` | pay contributors debits treasury | 20260924002549 | 133_migration_pay_contributors_debits_treasury |
| 134 | `134_migration_prize_distribution_hardening.sql` | prize distribution hardening | 20260924002625 | 134_migration_prize_distribution_hardening |
| 135 | `135_migration_compute_placements_authorization.sql` | compute placements authorization | 20260924002654 | 135_migration_compute_placements_authorization |
| 136 | `136_migration_placement_split_unique_place.sql` | placement split unique place | 20260924002711 | 136_migration_placement_split_unique_place |
| 137 | `137_migration_guild_membership_and_closure_race_fixes.sql` | guild membership and closure race fixes | 20260924002739 | 137_migration_guild_membership_and_closure_race_fixes |
| 138 | `138_migration_deposit_escrow_event_locks.sql` | deposit escrow event locks | 20260924011822 | 138_migration_deposit_escrow_event_locks |
| 139 | `139_migration_anthology_custom_split_dup_check.sql` | anthology custom split dup check | 20260924011903 | 139_migration_anthology_custom_split_dup_check |
| 140 | `140_migration_pending_deletion_blocks_guild_founding.sql` | pending deletion blocks guild founding | 20260924011918 | 140_migration_pending_deletion_blocks_guild_founding |
| 141 | `141_migration_profile_reserved_name_trigger.sql` | profile reserved name trigger | 20260924011924 | 141_migration_profile_reserved_name_trigger |
| 142 | `142_migration_unique_profile_names.sql` | unique profile names | 20260924011937 | 142_migration_unique_profile_names |
| 143 | `143_migration_restore_author_balance_reward_terms.sql` | restore author balance reward terms | 20260924211758 | 143_migration_restore_author_balance_reward_terms |
| 143 | `143_migration_revoke_client_execute_refund_escrow_contributors.sql` | revoke client execute refund escrow contributors | 20260924012207 | 143_revoke_client_execute_refund_escrow_contributors |
| 144 | `144_migration_purchase_init_hardening.sql` | purchase init hardening | 20260924215643 | 144_migration_purchase_init_hardening |
| 145 | `145_migration_withdrawal_idempotency_key.sql` | withdrawal idempotency key | 20260924220104 | 145_migration_withdrawal_idempotency_key |
| 146 | `146_migration_event_entry_limit_late_webhook.sql` | event entry limit late webhook | 20260924210903 | 146_migration_event_entry_limit_late_webhook |
| 147 | `147_migration_revoke_clears_treasurer_flag.sql` | revoke clears treasurer flag | 20260925074303 | 147_migration_revoke_clears_treasurer_flag |
| 148 | `148_migration_admin_revocation_floor.sql` | admin revocation floor | 20260925074312 | 148_migration_admin_revocation_floor |
| 149 | `149_migration_revoke_anon_execute_admin_gated_guild_event_fns.sql` | revoke anon execute admin gated guild event fns | 20260925074737 | 149_migration_revoke_anon_execute_admin_gated_guild_event_fns |
| 150 | `150_migration_moderation_removal_audit_log.sql` | moderation removal audit log | 20260925074326 | 150_migration_moderation_removal_audit_log |
| 151 | `151_migration_guild_ownership_transfer.sql` | guild ownership transfer | 20260925074344 | 151_migration_guild_ownership_transfer |
| 152 | `152_migration_anon_grant_audit_followup.sql` | anon grant audit followup | 20260925075157 | 152_migration_anon_grant_audit_followup |
| 152 | `152_migration_platform_posts.sql` | platform posts | 20260926062506 | 152_migration_platform_posts |
| 153 | `153_migration_default_privileges_no_anon_execute.sql` | default privileges no anon execute | 20260925075728 | 153_migration_default_privileges_no_anon_execute |
| 153 | `153_migration_platform_posts_v2.sql` | platform posts v2 | 20260926062604 | 153_migration_platform_posts_v2 |
| 154 | `154_migration_revoke_anon_moderator_set_content_removed.sql` | revoke anon moderator set content removed | 20260926073536 | 154_migration_revoke_anon_moderator_set_content_removed |
| 155 | `155_migration_player_guild_fireside.sql` | player guild fireside | 20260927000842 | 155_migration_player_guild_fireside |
| 156 | `156_migration_fix_transfer_guild_ownership_anon_null_bypass.sql` | fix transfer guild ownership anon null bypass | 20260926101246 | 156_fix_transfer_guild_ownership_anon_null_bypass |
| 157 | `157_migration_fix_guild_officer_and_treasury_authorized_null_bypass.sql` | fix guild officer and treasury authorized null bypass | 20260926144231 | 157_fix_guild_officer_and_treasury_authorized_null_bypass |
| 158 | `158_migration_fix_treasury_referral_analytics_null_bypass.sql` | fix treasury referral analytics null bypass | 20260926195048 | 158_fix_treasury_referral_analytics_null_bypass |
| 159 | `159_migration_pin_search_path_remaining_functions.sql` | pin search path remaining functions | 20260926214405 | 159_migration_pin_search_path_remaining_functions |
| 160 | `160_migration_index_unindexed_foreign_keys.sql` | index unindexed foreign keys | 20260926214713 | 160_migration_index_unindexed_foreign_keys |
| 161 | `161_migration_lower_solo_publish_word_floor.sql` | lower solo publish word floor | 20260927022534 | 161_migration_lower_solo_publish_word_floor |
| 162 | `162_migration_linked_profiles.sql` | linked profiles | 20260927220012 | 162_migration_linked_profiles |
| 163 | `163_migration_gate_linked_profiles_from_player_guilds.sql` | gate linked profiles from player guilds | 20260927220055 | 163_migration_gate_linked_profiles_from_player_guilds |
| 164 | `164_migration_route_linked_profile_earnings_to_main.sql` | route linked profile earnings to main | 20260927220113 | 164_migration_route_linked_profile_earnings_to_main |
| 165 | `165_migration_cascade_ban_to_linked_profiles.sql` | cascade ban to linked profiles | 20260927220137 | 165_migration_cascade_ban_to_linked_profiles |
| 166 | `166_migration_guild_event_writing_word_range.sql` | guild event writing word range | 20260928195936 | guild_event_writing_word_range |
| 167 | `167_migration_restore_activation_judging_gate.sql` | restore activation judging gate | 20260928225733 | 167_migration_restore_activation_judging_gate |
| 168 | `168_migration_guild_event_prize_rules.sql` | guild event prize rules | 20260928225812 | 168_migration_guild_event_prize_rules |
| 169 | `169_migration_admin_judges_and_judge_free_events.sql` | admin judges and judge free events | 20260929081120 | 169_migration_admin_judges_and_judge_free_events |
| 170 | `170_migration_entrant_results_public_listing_server_word_count.sql` | entrant results public listing server word count | 20260929081249 | 170_migration_entrant_results_public_listing_server_word_count |
| 171 | `171_migration_giveaway_backend.sql` | giveaway backend | 20260929081510 | 171_migration_giveaway_backend |
| 172 | `172_migration_quiz_backend.sql` | quiz backend | 20260929081742 | 172_migration_quiz_backend |
| 173 | `173_migration_close_computed_approval_bypass_admin_payout_queue.sql` | close computed approval bypass admin payout queue | 20260929081842 | 173_migration_close_computed_approval_bypass_admin_payout_queue |
| 174 | `174_migration_shared_quiz_bank.sql` | shared quiz bank | 20260929082235 | 174_migration_shared_quiz_bank |
| 175 | `175_migration_writing_entry_limits.sql` | writing entry limits | 20260929082247 | 175_migration_writing_entry_limits |
| 176 | `176_migration_tournament_backend.sql` | tournament backend | 20260929082516 | 176_migration_tournament_backend |
| 177 | `177_migration_tournament_participant_limit.sql` | tournament participant limit | 20260929082524 | 177_migration_tournament_participant_limit |
| 178 | `178_migration_quiz_suggestion_rate_limit.sql` | quiz suggestion rate limit | 20260929082542 | 178_migration_quiz_suggestion_rate_limit |
| 179 | `179_migration_inkroot_official_question_bank.sql` | inkroot official question bank | 20260929082630 | 179_migration_inkroot_official_question_bank |
| 180 | `180_migration_judge_free_place_limits.sql` | judge free place limits | 20260929083946 | judge_free_place_limits |
| 180 | `180_revoke_client_grants_quiz_tables.sql` | revoke client grants quiz tables | 20260929083028 | 180_revoke_client_grants_quiz_tables |
| 181 | `181_migration_giveaway_tie_break.sql` | giveaway tie break | 20260929084742 | giveaway_tie_break |
| 182 | `182_migration_quiz_pool_15_to_40.sql` | quiz pool 15 to 40 | 20260929221828 | 182_migration_quiz_pool_15_to_40 |
| 183 | `183_migration_quiz_review_owner_and_officer.sql` | quiz review owner and officer | 20260929221847 | 183_migration_quiz_review_owner_and_officer |
| 184 | `184_migration_quiz_reviewers_cannot_play.sql` | quiz reviewers cannot play | 20260929221906 | 184_migration_quiz_reviewers_cannot_play |
| 185 | `185_migration_official_quiz_and_tournament_events.sql` | official quiz and tournament events | 20260929223515 | 185_migration_official_quiz_and_tournament_events |
| 186 | `186_migration_refunds_owed_on_cancelled_events.sql` | refunds owed on cancelled events | 20260929223533 | 186_migration_refunds_owed_on_cancelled_events |
| 187 | `187_migration_official_quiz_auto_payout.sql` | official quiz auto payout | 20260929223548 | 187_migration_official_quiz_auto_payout |
| 188 | `188_migration_pause_judge_free_event_types.sql` | pause judge free event types | 20260929231800 | pause_judge_free_event_types |
| 189 | `189_migration_official_placements_skip_refunded_entries.sql` | official placements skip refunded entries | 20260929231341 | official_placements_skip_refunded_entries |
| 190 | `190_migration_list_my_linked_profiles.sql` | list my linked profiles | 20261001001942 | 190_list_my_linked_profiles |
| 191 | `191_migration_anthology_card_stats.sql` | anthology card stats | 20261002094214 | 191_migration_anthology_card_stats |
| 192 | `192_migration_resume_judge_free_event_types.sql` | resume judge free event types | 20261002094218 | 192_migration_resume_judge_free_event_types |
| 193 | `193_migration_draw_giveaway_client_role_check.sql` | draw giveaway client role check | 20261002194549 | draw_giveaway_client_role_check |
| 194 | `194_migration_pin_search_path_and_revoke_anon_writes.sql` | pin search path and revoke anon writes | 20261002195951 | pin_search_path_and_revoke_anon_writes |
