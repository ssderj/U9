-- ============================================================================================
-- Test for migration 144 (supabase/history/144_migration_purchase_init_hardening.sql)
-- — concurrent double-tap protection for book inits, and the locked pack purchase init.
--
-- How to run: same as supabase/tests/140_–143_: scratch/dev database with supabase/schema.sql
-- applied through migration 144, as a role that bypasses RLS (postgres), SQL editor or
-- `psql -f`. One transaction that ROLLS BACK; a failing case raises 'FAIL: ...' and aborts; a
-- clean run ends with 'PASS: ...'. Not for production (inserts, then rolls back, auth.users rows).
--
-- Cases (books):
--   1. first init                                             -> one pending row
--   2. second init within 15 s                                -> refused ('payment in progress')
--   3. same, once the first pending row is older than 15 s    -> allowed (abandoned checkout retry)
--   4. after a success row exists                             -> refused ('already own')
--   5. two tips back to back                                  -> both allowed (tips are repeatable)
--   6. buyer = author; non-service_role caller                -> refused
--   7. a second SUCCESS row for the same book can still be written (no unique index by design,
--      so the webhook can always settle a second successful charge)
-- Cases (packs):
--   8. paid pack: first ok, immediate second refused, backdated retry ok, owned -> refused
--   9. free pack: returns a settled $0 row; a second call returns the SAME row (no duplicate)
--  10. unlisted pack / wrong author / buyer = author / non-service_role -> refused
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
  author uuid := gen_random_uuid();
  buyer uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  book text := 'test-book-144';
  pack text := 'test-pack-144';
  free_pack text := 'test-pack-144-free';
  hidden_pack text := 'test-pack-144-hidden';
  r purchases;
  r2 purchases;
  n integer;
begin
  insert into auth.users (id) values (author), (buyer), (other);

  perform pg_temp.act_as(null, null);
  insert into published_books (id, author_id, title) values (book, author, 'Test Book 144');
  insert into published_packs (id, author_id, project_id, pack_key, title, price)
  values (pack, author, 'proj-144', 'pack-key-144', 'Paid Pack 144', 500),
         (free_pack, author, 'proj-144', 'pack-key-144-free', 'Free Pack 144', 0);
  insert into published_packs (id, author_id, project_id, pack_key, title, price, unlisted)
  values (hidden_pack, author, 'proj-144', 'pack-key-144-hidden', 'Hidden Pack 144', 500, true);

  -- Everything below is what the edge functions do: run as service_role.
  perform pg_temp.act_as(null, 'service_role');

  -- 1. First book init.
  r := create_purchase_locked(buyer, author, 'book', book, 'test-ref-144-book-1', 50000, 45000);
  if r.status <> 'pending' then raise exception 'FAIL: first init should be pending, got %', r.status; end if;

  -- 2. Immediate second init is a double-tap.
  perform pg_temp.expect_error(
    format('select create_purchase_locked(%L, %L, %L, %L, %L, 50000, 45000)', buyer, author, 'book', book, 'test-ref-144-book-2'),
    'You already have a payment in progress for this book%');

  -- 3. Once the first attempt is older than 15 s it is an abandoned checkout: retry allowed.
  update purchases set created_at = now() - interval '1 minute' where paystack_reference = 'test-ref-144-book-1';
  r2 := create_purchase_locked(buyer, author, 'book', book, 'test-ref-144-book-3', 50000, 45000);
  if r2.paystack_reference <> 'test-ref-144-book-3' then raise exception 'FAIL: retry after an old pending row should be allowed'; end if;

  -- 4. Success row -> already owned.
  update purchases set status = 'success', paid_at = now() where paystack_reference = 'test-ref-144-book-3';
  perform pg_temp.expect_error(
    format('select create_purchase_locked(%L, %L, %L, %L, %L, 50000, 45000)', buyer, author, 'book', book, 'test-ref-144-book-4'),
    'You already own this book%');

  -- 5. Tips are repeatable, even back to back.
  perform create_purchase_locked(buyer, author, 'tip', null, 'test-ref-144-tip-1', 10000, 9000);
  perform create_purchase_locked(buyer, author, 'tip', null, 'test-ref-144-tip-2', 10000, 9000);

  -- 6. Own book, and a caller that is not service_role.
  perform pg_temp.expect_error(
    format('select create_purchase_locked(%L, %L, %L, %L, %L, 50000, 45000)', author, author, 'book', book, 'test-ref-144-book-5'),
    'A buyer cannot purchase or tip their own book.%');
  perform pg_temp.act_as(buyer);
  perform pg_temp.expect_error(
    format('select create_purchase_locked(%L, %L, %L, %L, %L, 50000, 45000)', buyer, author, 'book', book, 'test-ref-144-book-6'),
    'Not authorized.%');
  perform pg_temp.act_as(null, 'service_role');

  -- 7. No unique index on successful purchases: a second success row for the same book is
  --    writable, so the webhook can always settle a second successful charge.
  insert into purchases (paystack_reference, buyer_id, author_id, kind, book_id, amount_kobo, author_amount_kobo, status, paid_at)
  values ('test-ref-144-book-dup', buyer, author, 'book', book, 50000, 45000, 'success', now());
  select count(*) into n from purchases where buyer_id = buyer and book_id = book and status = 'success';
  if n <> 2 then raise exception 'FAIL: expected 2 success rows (no unique index), got %', n; end if;

  -- 8. Paid pack.
  r := create_pack_purchase_locked(buyer, author, pack, 'test-ref-144-pack-1', 50000, 45000);
  if r.status <> 'pending' or r.kind <> 'pack' or r.pack_id <> pack then
    raise exception 'FAIL: paid pack init should be a pending pack row';
  end if;
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', buyer, author, pack, 'test-ref-144-pack-2'),
    'You already have a payment in progress for this pack%');
  update purchases set created_at = now() - interval '1 minute' where paystack_reference = 'test-ref-144-pack-1';
  perform create_pack_purchase_locked(buyer, author, pack, 'test-ref-144-pack-3', 50000, 45000);
  update purchases set status = 'success', paid_at = now() where paystack_reference = 'test-ref-144-pack-3';
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', buyer, author, pack, 'test-ref-144-pack-4'),
    'You already own this pack%');

  -- 9. Free pack: settled $0 row, idempotent on repeat.
  r := create_pack_purchase_locked(other, author, free_pack, 'test-ref-144-free-1', 0, 0);
  if r.status <> 'success' or r.amount_kobo <> 0 then raise exception 'FAIL: free pack should be a settled $0 row'; end if;
  r2 := create_pack_purchase_locked(other, author, free_pack, 'test-ref-144-free-2', 0, 0);
  if r2.id <> r.id then raise exception 'FAIL: second free-pack call should return the existing row'; end if;
  select count(*) into n from purchases where buyer_id = other and pack_id = free_pack;
  if n <> 1 then raise exception 'FAIL: expected exactly 1 free-pack row, got %', n; end if;

  -- 10. Refusals.
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', buyer, author, hidden_pack, 'test-ref-144-hidden'),
    'Pack not found%');
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', other, buyer, pack, 'test-ref-144-wrong-author'),
    'Invalid pack author.%');
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', author, author, pack, 'test-ref-144-own'),
    'A buyer cannot purchase their own pack.%');
  perform pg_temp.act_as(other);
  perform pg_temp.expect_error(
    format('select create_pack_purchase_locked(%L, %L, %L, %L, 50000, 45000)', other, author, pack, 'test-ref-144-anon'),
    'Not authorized.%');

  raise notice 'PASS: migration 144 — double-tap guard for books, locked and idempotent pack purchase init';
end;
$$;

rollback;
