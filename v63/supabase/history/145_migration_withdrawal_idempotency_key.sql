-- ============================================================================================
-- Migration 145: idempotency key for manual withdrawal requests.
--
-- Background (failure-recovery audit, finding #10): create_manual_withdrawal_locked() has no
-- replay protection. If the response to a withdrawal request is lost (network drop, timeout)
-- after the row was created, the Withdraw modal returns to its Confirm step and a second click
-- creates a SECOND pending withdrawal whenever the balance still covers it. The guild treasury
-- RPCs already solve this with a caller-supplied idempotency key; this gives withdrawals the same
-- shape.
--
-- What changes:
--   * withdrawals.idempotency_key (nullable text, 8-64 chars when present) with a partial unique
--     index on (user_id, idempotency_key) — scoped per user, so two users can never collide or
--     replay each other's request.
--   * create_manual_withdrawal_locked() gains a 4th argument, p_idempotency_key text DEFAULT NULL.
--     With a key: a repeat request from the same user with the same key returns the ORIGINAL row
--     (no second row, no second debit) — provided it is for the same bank account and amount;
--     the same key with different details is refused, because that is a different request that
--     must get its own key. Without a key the function behaves exactly as before, so the deployed
--     manual-withdraw edge function keeps working unchanged until it is updated to send one.
--   * The replay lookup runs under the per-user advisory lock the function already takes, so two
--     identical concurrent requests cannot both insert.
--
-- All existing checks are preserved and unchanged in order of effect: service_role only, positive
-- amount, the account must belong to the user, new-payout-account cooldown (migration 111), and
-- balance >= amount under the lock. A replay returns before the cooldown and balance checks on
-- purpose: it must never fail just because the earlier, successful attempt already lowered the
-- balance.
--
-- create_withdrawal_locked() (the Paystack-transfer path, currently disabled in the client) is NOT
-- touched.
--
-- The old 3-argument signature is dropped and replaced (Postgres cannot add a parameter with
-- create or replace, and keeping both would make 3-argument named calls ambiguous). Apply in a
-- quiet moment: for the fraction of a second between the DROP and the CREATE a withdrawal request
-- would fail with "function not found" (run the script as one transaction to avoid even that).
-- Deploy order: this migration, then manual-withdraw (to send and honor the key), then the client.
-- ============================================================================================

alter table withdrawals add column if not exists idempotency_key text;

alter table withdrawals drop constraint if exists withdrawals_idempotency_key_length;
alter table withdrawals add constraint withdrawals_idempotency_key_length
  check (idempotency_key is null or char_length(idempotency_key) between 8 and 64);

create unique index if not exists withdrawals_user_idempotency_key_idx
  on withdrawals (user_id, idempotency_key) where idempotency_key is not null;

drop function if exists create_manual_withdrawal_locked(uuid, uuid, bigint);

create or replace function create_manual_withdrawal_locked(
  p_user_id uuid, p_bank_account_id uuid, p_amount_kobo bigint, p_idempotency_key text default null
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
  v_key text := nullif(btrim(p_idempotency_key), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if v_key is not null and char_length(v_key) not between 8 and 64 then
    raise exception 'Invalid request key.';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and user_id = p_user_id) then
    raise exception 'Saved bank account not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));

  -- Replay: same user + same key. Returned before the cooldown/balance checks (see header).
  if v_key is not null then
    select * into v_row from withdrawals where user_id = p_user_id and idempotency_key = v_key;
    if found then
      if v_row.bank_account_id <> p_bank_account_id or v_row.amount_kobo <> p_amount_kobo then
        raise exception 'This request was already used for a different withdrawal — please start again.';
      end if;
      return v_row;
    end if;
  end if;

  perform assert_bank_account_cooldown_elapsed(p_user_id, p_bank_account_id);

  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status, method, idempotency_key)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending', 'manual', v_key)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_manual_withdrawal_locked(uuid, uuid, bigint, text) from public;
-- Also drop the anon/authenticated grants Supabase's default privileges add to new functions (see 143).
revoke all on function create_manual_withdrawal_locked(uuid, uuid, bigint, text) from anon, authenticated;
