-- ============================================================================================
-- Migration 164: route linked-profile earnings to the main account
-- ============================================================================================
-- author_balance_kobo(check_user_id) is the single function every balance/withdrawal path reads
-- from — it's derived, not a stored column, so nothing that writes purchases, achievement_grants,
-- referral_grants, or guild_treasury_transactions needs to change. Redefining only this function
-- expands check_user_id into itself plus any linked secondaries, on every EARNING-side subquery.
--
-- Left as check_user_id only (never expanded): withdrawals.user_id, and the two
-- guild_treasury_transactions SPENDING terms (contribution, event_prize_escrow_contribution) —
-- a linked profile can't spend or withdraw the main account's money, only earn into it, and
-- linked profiles have no client UI path to initiate a withdrawal or contribution anyway, so
-- there's no existing row under a secondary's id to reason about here.
create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
declare
  v_ids uuid[];
begin
  if check_user_id is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  select array_agg(secondary_id) into v_ids from linked_profiles where main_id = check_user_id;
  v_ids := array_append(coalesce(v_ids, array[]::uuid[]), check_user_id);

  return
    -- Sales (anthology-book purchases are excluded: their share is distributed through the guild
    -- treasury instead — migration 37). Earning side: expanded to v_ids.
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = any(v_ids) and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    -- Spending side: withdrawals always belong to the main account only.
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    -- Spending side: a guild-treasury contribution is money leaving the contributor's own
    -- balance — left as check_user_id only, same reasoning as withdrawals above.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    -
    -- Migration 131: a locked-in escrow contribution leaves the contributor's own balance —
    -- spending side, same as the contribution term above.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'event_prize_escrow_contribution'
                and status in ('pending', 'success')), 0)
    +
    -- Earning side: expanded to v_ids.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = any(v_ids) and kind = 'release_to_member' and status = 'success'), 0)
    +
    -- Migration 131: an escrow refund or payout comes back into the contributor's balance —
    -- earning side, expanded to v_ids.
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = any(v_ids)
                and kind in ('event_prize_escrow_contributor_refund', 'event_prize_escrow_contributor_payout')
                and status = 'success'), 0)
    +
    -- Migration 52 / 110: achievement Naira grants, net of reversals — earning side, expanded.
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = any(v_ids)), 0)
    -
    coalesce((select sum(x.kobo_reversed) from achievement_grant_reversals x
              join achievement_grants ag on ag.id = x.achievement_grant_id
              where ag.user_id = any(v_ids)), 0)
    +
    -- Migration 56 / 58: referral Naira grants, net of reversals — earning side, expanded.
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = any(v_ids)), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = any(v_ids)), 0);
end;
$$ language plpgsql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
