-- ============================================================================================
-- Migration 160: index every unindexed foreign key
-- ============================================================================================
-- Adds a covering index for every foreign key the performance advisor flagged as unindexed.
-- Purely additive (no logic/behavior change) — speeds up joins/deletes/cascades on these
-- columns as the tables grow; costs a little disk space and a small write-time overhead.
--
-- Applied live 2026-09-26 as 160_migration_index_unindexed_foreign_keys. Performance advisor
-- re-scan post-migration: unindexed_foreign_keys finding count dropped to 0.

create index if not exists idx_admin_role_revocations_revoked_by on public.admin_role_revocations (revoked_by);
create index if not exists idx_admin_role_revocations_target_user_id on public.admin_role_revocations (target_user_id);
create index if not exists idx_book_discussion_posts_author_id on public.book_discussion_posts (author_id);
create index if not exists idx_book_publish_events_author_id on public.book_publish_events (author_id);
create index if not exists idx_content_reports_resolved_by on public.content_reports (resolved_by);
create index if not exists idx_device_signals_user_id on public.device_signals (user_id);
create index if not exists idx_fireside_posts_author_id on public.fireside_posts (author_id);
create index if not exists idx_fireside_posts_parent_id on public.fireside_posts (parent_id);
create index if not exists idx_fireside_reactions_user_id on public.fireside_reactions (user_id);
create index if not exists idx_guild_anthologies_created_by on public.guild_anthologies (created_by);
create index if not exists idx_guild_anthology_revenue_agreements_created_by on public.guild_anthology_revenue_agreements (created_by);
create index if not exists idx_guild_anthology_revenue_shares_contributor_id on public.guild_anthology_revenue_shares (contributor_id);
create index if not exists idx_guild_anthology_submissions_contributor_id on public.guild_anthology_submissions (contributor_id);
create index if not exists idx_guild_anthology_submissions_reviewed_by on public.guild_anthology_submissions (reviewed_by);
create index if not exists idx_guild_book_feedback_author_id on public.guild_book_feedback (author_id);
create index if not exists idx_guild_event_entries_entrant_id on public.guild_event_entries (entrant_id);
create index if not exists idx_guild_event_financial_agreements_created_by on public.guild_event_financial_agreements (created_by);
create index if not exists idx_guild_event_hosting_fee_payments_guild_id on public.guild_event_hosting_fee_payments (guild_id);
create index if not exists idx_guild_event_hosting_fee_payments_paid_by on public.guild_event_hosting_fee_payments (paid_by);
create index if not exists idx_guild_event_hosting_fee_payments_rate_id on public.guild_event_hosting_fee_payments (rate_id);
create index if not exists idx_guild_event_hosting_fee_rates_created_by on public.guild_event_hosting_fee_rates (created_by);
create index if not exists idx_guild_event_judge_scores_judge_id on public.guild_event_judge_scores (judge_id);
create index if not exists idx_guild_event_objective_config_created_by on public.guild_event_objective_config (created_by);
create index if not exists idx_guild_event_results_reviewed_by on public.guild_event_results (reviewed_by);
create index if not exists idx_guild_event_results_submitted_by on public.guild_event_results (submitted_by);
create index if not exists idx_guild_event_submissions_entrant_id on public.guild_event_submissions (entrant_id);
create index if not exists idx_guild_events_cancelled_by on public.guild_events (cancelled_by);
create index if not exists idx_guild_events_created_by on public.guild_events (created_by);
create index if not exists idx_guild_events_organizer_id on public.guild_events (organizer_id);
create index if not exists idx_guild_events_reviewed_by on public.guild_events (reviewed_by);
create index if not exists idx_guild_join_events_user_id on public.guild_join_events (user_id);
create index if not exists idx_guild_order_chapters_proposed_by on public.guild_order_chapters (proposed_by);
create index if not exists idx_guild_order_passages_author_id on public.guild_order_passages (author_id);
create index if not exists idx_guild_order_proposals_opened_by on public.guild_order_proposals (opened_by);
create index if not exists idx_guild_order_votes_voter_id on public.guild_order_votes (voter_id);
create index if not exists idx_guild_order_world_entries_author_id on public.guild_order_world_entries (author_id);
create index if not exists idx_guild_ownership_transfers_guild_id on public.guild_ownership_transfers (guild_id);
create index if not exists idx_guild_ownership_transfers_new_owner_id on public.guild_ownership_transfers (new_owner_id);
create index if not exists idx_guild_ownership_transfers_previous_owner_id on public.guild_ownership_transfers (previous_owner_id);
create index if not exists idx_guild_published_books_author_id on public.guild_published_books (author_id);
create index if not exists idx_guild_quest_events_guild_id_user_id on public.guild_quest_events (guild_id, user_id);
create index if not exists idx_guild_treasury_spend_approvals_approver_id on public.guild_treasury_spend_approvals (approver_id);
create index if not exists idx_guild_treasury_spend_requests_requested_by on public.guild_treasury_spend_requests (requested_by);
create index if not exists idx_guild_treasury_spend_requests_transaction_id on public.guild_treasury_spend_requests (transaction_id);
create index if not exists idx_guild_treasury_transactions_created_by on public.guild_treasury_transactions (created_by);
create index if not exists idx_notifications_actor_id on public.notifications (actor_id);
create index if not exists idx_platform_post_comments_author_id on public.platform_post_comments (author_id);
create index if not exists idx_platform_post_reactions_user_id on public.platform_post_reactions (user_id);
create index if not exists idx_platform_posts_author_id on public.platform_posts (author_id);
create index if not exists idx_player_guild_members_user_id on public.player_guild_members (user_id);
create index if not exists idx_purchases_book_id on public.purchases (book_id);
create index if not exists idx_purchases_buyer_id on public.purchases (buyer_id);
create index if not exists idx_reviews_reviewer_id on public.reviews (reviewer_id);
create index if not exists idx_withdrawals_bank_account_id on public.withdrawals (bank_account_id);
create index if not exists idx_withdrawals_settled_by on public.withdrawals (settled_by);
