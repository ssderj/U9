-- ============================================================================================
-- Test for migration 143 (supabase/history/143_migration_restore_author_balance_reward_terms.sql)
-- — author_balance_kobo() counts every credit/debit source again and only answers for the caller.
--
-- How to run: same as supabase/tests/140_–142_: scratch/dev database with supabase/schema.sql
-- applied through migration 143, as a role that bypasses RLS (postgres), SQL editor or
-- `psql -f`. One transaction that ROLLS BACK; a failing case raises 'FAIL: ...' and aborts; a
-- clean run ends with 'PASS: ...'. Not for production (inserts, then rolls back, auth.users rows).
--
-- Expected balance for the seeded user A (kobo):
--     +90000  sale (author share)
--     +10000  achievement grant      -4000  its reversal
--      +5000  referral grant         -2000  its reversal
--     -20000  pending withdrawal
--      -7000  escrow contribution
--      +3000  escrow contributor refund
--     = 75000
--
-- Cases:
--   1. a user with nothing                                        -> 0
--   2. every term seeded above, read as the user themself          -> 75000
--   3. same number read as service_role                            -> 75000
--   4. another signed-in user asking for A's balance               -> refused ('Not authorized.')
--   5. no caller at all                                            -> refused
--   6. the stored definition mentions the reward tables            -> guards against a repeat of 131
-- ============================================================================================

begin;

create function pg_temp.act_as(p_user uuid, p_role text default 'authenticated') returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
  perform set_config('request.jwt.claims',
    case when p_role is null then ''
         when p_user is null then json_build_object('role', p_role)::text
         else json_build_object('sub', p_user, 'role', p_role)::text end, true);
end;
$$;

create function pg_temp.expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_pattern then
      return;
    end if;
    raise exception 'FAIL: expected an error like "%" but got: %', p_pattern, sqlerrm;
  end;
  raise exception 'FAIL: expected an error like "%" but the call succeeded', p_pattern;
end;
$$;

do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  g uuid := gen_random_uuid();
  bank uuid;
  ag uuid;
  rf uuid;
  rg uuid;
  bal bigint;
begin
  insert into auth.users (id) values (a), (b);

  -- 1. Nothing seeded yet.
  perform pg_temp.act_as(a);
  bal := author_balance_kobo(a);
  if bal <> 0 then raise exception 'FAIL: fresh user balance should be 0, got %', bal; end if;

  -- Seed every source. All inserts run as the (RLS-bypassing) test role.
  perform pg_temp.act_as(null, null);

  -- Sale: B bought A's book.
  insert into published_books (id, author_id, title) values ('test-book-143', a, 'Test Book 143');
  insert into purchases (paystack_reference, buyer_id, author_id, kind, book_id, amount_kobo, author_amount_kobo, status)
  values ('test-ref-143-1', b, a, 'book', 'test-book-143', 100000, 90000, 'success');

  -- Achievement grant + reversal.
  insert into achievement_grants (user_id, achievement_id, naira_reward_kobo)
  values (a, 'nairaFirstPurchase', 10000) returning id into ag;
  insert into achievement_grant_reversals (achievement_grant_id, kobo_reversed, reason)
  values (ag, 4000, 'test reversal');

  -- Referral grant + reversal (A referred B).
  insert into referrals (referrer_id, referee_id) values (a, b) returning id into rf;
  insert into referral_grants (referral_id, kind, naira_reward_kobo)
  values (rf, 'reader_purchase', 5000) returning id into rg;
  insert into referral_grant_reversals (referral_grant_id, kobo_reversed, reason)
  values (rg, 2000, 'test reversal');

  -- Pending withdrawal (A's first-ever bank account is exempt from the new-account cooldown).
  insert into bank_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code)
  values (a, '058', 'Test Bank', '0123456789', 'Test Account', 'RCP_test_143') returning id into bank;
  insert into withdrawals (user_id, bank_account_id, amount_kobo, status, method)
  values (a, bank, 20000, 'pending', 'manual');

  -- Escrow contribution (debit from A) and a contributor refund (credit back to A, in part).
  insert into player_guilds (id, name, owner_id) values (g, 'Test Guild 143', a);
  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination, status, title, created_by)
  values
    (g, 'guild', null, 'credit', 'event_prize_escrow_contribution', 7000, 'NGN',
     'member_balance', 'event_prize_escrow_held', 'success', 'test contribution', a);
  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination, status, title, created_by)
  values
    (g, 'member', a, 'credit', 'event_prize_escrow_contributor_refund', 3000, 'NGN',
     'event_prize_escrow_held', 'member_balance', 'success', 'test refund', a);

  -- 2. As the user themself.
  perform pg_temp.act_as(a);
  bal := author_balance_kobo(a);
  if bal <> 75000 then raise exception 'FAIL: expected 75000 as the user, got %', bal; end if;

  -- 3. As service_role (what create_*withdrawal_locked runs as).
  perform pg_temp.act_as(null, 'service_role');
  bal := author_balance_kobo(a);
  if bal <> 75000 then raise exception 'FAIL: expected 75000 as service_role, got %', bal; end if;

  -- 4. Another signed-in user may not read A's balance.
  perform pg_temp.act_as(b);
  perform pg_temp.expect_error(format('select author_balance_kobo(%L)', a), 'Not authorized.%');

  -- 5. No caller at all.
  perform pg_temp.act_as(null, null);
  perform pg_temp.expect_error(format('select author_balance_kobo(%L)', a), 'Not authorized.%');

  -- 6. The live definition carries the reward terms and the caller check.
  if not exists (
    select 1 from pg_proc
    where proname = 'author_balance_kobo'
      and prosrc like '%achievement_grants%'
      and prosrc like '%referral_grants%'
      and prosrc like '%achievement_grant_reversals%'
      and prosrc like '%referral_grant_reversals%'
      and prosrc like '%Not authorized.%'
  ) then
    raise exception 'FAIL: author_balance_kobo() is missing a reward term or the caller check';
  end if;

  raise notice 'PASS: migration 143 — author_balance_kobo() counts all sources and only answers for the caller';
end;
$$;

rollback;
