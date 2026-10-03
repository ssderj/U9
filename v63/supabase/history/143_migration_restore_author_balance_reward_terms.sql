-- ============================================================================================
-- Migration 143: restore author_balance_kobo()'s reward terms and its caller check.
--
-- What went wrong: migration 131 (guild event contributor escrow) redefined author_balance_kobo()
-- to add two escrow terms, but it was written from an older copy of the function (a `language sql`
-- version from before the reward terms existed) instead of migration 110's. Everything added between
-- those two versions was silently dropped from the live definition:
--
--   1. Achievement Naira grants (migration 52) — `+ sum(achievement_grants.naira_reward_kobo)`.
--   2. Achievement grant reversals (migration 110) — `- sum(achievement_grant_reversals.kobo_reversed)`.
--   3. Referral Naira grants (migration 56) — `+ sum(referral_grants.naira_reward_kobo)`.
--   4. Referral grant reversals (migration 58/110) — `- sum(referral_grant_reversals.kobo_reversed)`.
--   5. The caller check from migration 100 — a signed-in user may only ask for their OWN
--      balance (service_role may ask for anyone's, which the withdrawal RPCs need).
--
-- Consequences while 131's version is live: a granted reward shows as unlocked in the UI but is
-- never part of the withdrawable balance, and any authenticated user can call
-- author_balance_kobo(<someone else's uuid>) and read that person's balance.
--
-- This migration: same name, same signature (uuid) -> bigint, same grants. The body is migration
-- 110's definition plus migration 131's three escrow terms, unchanged. Nothing else is touched.
-- No rows are written, so it is safe to re-run.
--
-- Effect on balances: rewards that were granted but not counted become withdrawable again the
-- moment this is applied. Run the pre-flight query below first if you want the number.
--
--   select coalesce((select sum(naira_reward_kobo) from achievement_grants), 0)
--        - coalesce((select sum(kobo_reversed) from achievement_grant_reversals), 0) as achievements_kobo,
--          coalesce((select sum(naira_reward_kobo) from referral_grants), 0)
--        - coalesce((select sum(kobo_reversed) from referral_grant_reversals), 0)    as referrals_kobo;
--
-- Callers audited (every one passes its own id or runs as service_role, so the restored check
-- cannot break them): the withdrawal RPCs (create_withdrawal_locked / create_manual_withdrawal_locked,
-- service_role with p_user_id), the guild treasury / escrow / member-earnings RPCs
-- (author_balance_kobo(auth.uid()), migrations 33, 34, 69, 122, 131), and
-- src/lib/payments.js fetchAvailableBalanceNaira (own id).
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
begin
  if check_user_id is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  return
    -- Sales (anthology-book purchases are excluded: their share is distributed through the guild
    -- treasury instead — migration 37).
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = check_user_id and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    -
    -- Migration 131: a locked-in escrow contribution leaves the contributor's own balance.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'event_prize_escrow_contribution'
                and status in ('pending', 'success')), 0)
    +
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = check_user_id and kind = 'release_to_member' and status = 'success'), 0)
    +
    -- Migration 131: an escrow refund or payout comes back into the contributor's balance.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = check_user_id
                and kind in ('event_prize_escrow_contributor_refund', 'event_prize_escrow_contributor_payout')
                and status = 'success'), 0)
    +
    -- Migration 52 / 110: achievement Naira grants, net of reversals.
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = check_user_id), 0)
    -
    coalesce((select sum(x.kobo_reversed) from achievement_grant_reversals x
              join achievement_grants ag on ag.id = x.achievement_grant_id
              where ag.user_id = check_user_id), 0)
    +
    -- Migration 56 / 58: referral Naira grants, net of reversals.
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0);
end;
$$ language plpgsql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
