-- ============================================================================================
-- Test for migration 145 (supabase/history/145_migration_withdrawal_idempotency_key.sql)
-- — create_manual_withdrawal_locked() replays a repeated request instead of duplicating it.
--
-- How to run: same as supabase/tests/140_–144_: scratch/dev database with supabase/schema.sql
-- applied through migration 145, as a role that bypasses RLS (postgres), SQL editor or
-- `psql -f`. One transaction that ROLLS BACK; a failing case raises 'FAIL: ...' and aborts; a
-- clean run ends with 'PASS: ...'. Not for production (inserts, then rolls back, auth.users rows).
--
-- Seed: A has one sale worth 90000 kobo (author share) and one saved bank account (a first-ever
-- account is exempt from the new-account cooldown). B has a sale worth 50000 kobo and a bank account.
--
-- Cases:
--   1. exactly one create_manual_withdrawal_locked() exists (the old 3-arg signature is gone)
--   2. the original 3-named-argument call (what manual-withdraw sends today) still works, no key
--   3. first request with a key                        -> pending manual row, key stored, balance debited once
--   4. same key, same details (a retry)                -> the SAME row back, still one row, balance unchanged
--   5. same key, different amount / different account  -> refused
--   6. a different key                                 -> a new row
--   7. no key, twice                                   -> two rows (optional key, legacy behaviour)
--   8. key too short                                   -> refused
--   9. another user, same key string                   -> independent (their own row)
--  10. balance too low with a fresh key                -> refused; non-service_role caller -> refused
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
  bank_a uuid;
  bank_a2 uuid;
  bank_b uuid;
  key1 text := 'test-key-145-first-attempt';
  key2 text := 'test-key-145-second-attempt';
  r withdrawals;
  r2 withdrawals;
  n integer;
  bal bigint;
begin
  insert into auth.users (id) values (a), (b);

  -- Seed as the RLS-bypassing test role.
  perform pg_temp.act_as(null, null);
  insert into published_books (id, author_id, title) values ('test-book-145-a', a, 'Test Book 145 A'), ('test-book-145-b', b, 'Test Book 145 B');
  insert into purchases (paystack_reference, buyer_id, author_id, kind, book_id, amount_kobo, author_amount_kobo, status)
  values ('test-ref-145-a', b, a, 'book', 'test-book-145-a', 100000, 90000, 'success'),
         ('test-ref-145-b', a, b, 'book', 'test-book-145-b',  55000, 50000, 'success');
  insert into bank_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code)
  values (a, '058', 'Test Bank', '0123456789', 'Test Account A', 'RCP_test_145_a') returning id into bank_a;
  insert into bank_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code)
  values (b, '058', 'Test Bank', '0987654321', 'Test Account B', 'RCP_test_145_b') returning id into bank_b;

  perform pg_temp.act_as(null, 'service_role');

  -- 1. The old 3-arg overload is gone; exactly one function remains.
  select count(*) into n from pg_proc where proname = 'create_manual_withdrawal_locked';
  if n <> 1 then raise exception 'FAIL: expected exactly one create_manual_withdrawal_locked, found %', n; end if;

  -- 2. The call shape manual-withdraw uses today (three named arguments, no key).
  r := create_manual_withdrawal_locked(p_user_id => a, p_bank_account_id => bank_a, p_amount_kobo => 1000);
  if r.status <> 'pending' or r.method <> 'manual' or r.idempotency_key is not null then
    raise exception 'FAIL: keyless call should create a pending manual row with no key';
  end if;
  -- A balance now: 90000 - 1000 = 89000.

  -- 3. First keyed request.
  r := create_manual_withdrawal_locked(a, bank_a, 20000, key1);
  if r.idempotency_key <> key1 or r.amount_kobo <> 20000 then raise exception 'FAIL: keyed request not stored as expected'; end if;
  bal := author_balance_kobo(a);
  if bal <> 69000 then raise exception 'FAIL: expected balance 69000 after the keyed withdrawal, got %', bal; end if;

  -- 4. Retry with the same key: same row, no second debit.
  r2 := create_manual_withdrawal_locked(a, bank_a, 20000, key1);
  if r2.id <> r.id then raise exception 'FAIL: replay should return the original row'; end if;
  select count(*) into n from withdrawals where user_id = a and idempotency_key = key1;
  if n <> 1 then raise exception 'FAIL: expected exactly 1 keyed row, got %', n; end if;
  bal := author_balance_kobo(a);
  if bal <> 69000 then raise exception 'FAIL: replay must not debit again (expected 69000, got %)', bal; end if;

  -- 5. Same key, different details.
  perform pg_temp.expect_error(
    format('select create_manual_withdrawal_locked(%L, %L, 25000, %L)', a, bank_a, key1),
    'This request was already used for a different withdrawal%');
  perform pg_temp.act_as(null, null);
  -- is_default = false: bank_accounts_one_default_per_user allows only one default account per user.
  insert into bank_accounts (user_id, bank_code, bank_name, account_number, account_name, paystack_recipient_code, is_default)
  values (a, '044', 'Other Bank', '1111111111', 'Test Account A2', 'RCP_test_145_a2', false) returning id into bank_a2;
  perform pg_temp.act_as(null, 'service_role');
  perform pg_temp.expect_error(
    format('select create_manual_withdrawal_locked(%L, %L, 20000, %L)', a, bank_a2, key1),
    'This request was already used for a different withdrawal%');

  -- 6. A different key is a new request.
  r2 := create_manual_withdrawal_locked(a, bank_a, 30000, key2);
  if r2.id = r.id then raise exception 'FAIL: a new key should create a new row'; end if;
  bal := author_balance_kobo(a);
  if bal <> 39000 then raise exception 'FAIL: expected balance 39000, got %', bal; end if;

  -- 7. Keyless requests are not deduplicated (key is optional).
  perform create_manual_withdrawal_locked(a, bank_a, 5000);
  perform create_manual_withdrawal_locked(a, bank_a, 5000);
  select count(*) into n from withdrawals where user_id = a;
  if n <> 5 then raise exception 'FAIL: expected 5 withdrawals for A (1 + key1 + key2 + 2 keyless), got %', n; end if;

  -- 8. Key too short.
  perform pg_temp.expect_error(
    format('select create_manual_withdrawal_locked(%L, %L, 1000, %L)', a, bank_a, 'short'),
    'Invalid request key.%');

  -- 9. Another user using the same key string: independent.
  r2 := create_manual_withdrawal_locked(b, bank_b, 10000, key1);
  if r2.user_id <> b or r2.id = r.id then raise exception 'FAIL: keys must be scoped per user'; end if;

  -- 10. Too much for the balance (fresh key), and a caller that is not service_role.
  perform pg_temp.expect_error(
    format('select create_manual_withdrawal_locked(%L, %L, 999999, %L)', a, bank_a, 'test-key-145-too-much'),
    'Amount is more than your available balance.%');
  perform pg_temp.act_as(a);
  perform pg_temp.expect_error(
    format('select create_manual_withdrawal_locked(%L, %L, 1000, %L)', a, bank_a, 'test-key-145-anon-call'),
    'Not authorized.%');

  raise notice 'PASS: migration 145 — repeated withdrawal requests replay instead of duplicating';
end;
$$;

rollback;
