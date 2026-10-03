-- ============================================================================================
-- Migration 144: purchase-init hardening — no concurrent double-tap charges, and a locked,
-- duplicate-aware init path for Worldbuilding Packs.
--
-- Background (failure-recovery audit, findings #1 and #21):
--
--   * create_purchase_locked() (migration 106) already serializes concurrent BOOK inits per
--     (buyer, book) and refuses when a 'success' row exists. It deliberately allowed several
--     'pending' rows to pile up, so a buyer who closed the checkout popup and pressed Buy again
--     simply got a second pending row. That is fine when the first attempt really was abandoned,
--     and is a double charge when it was not (bank transfer / USSD still confirming, or a slow
--     3-D Secure step). The edge function now asks Paystack about older pending rows before
--     calling this function (see paystack-init-purchase); THIS function closes the remaining
--     race — two init calls that both got past that check at the same moment — by refusing a
--     second pending row for the same buyer + book created within the last 15 seconds.
--     Older pending rows are not blocked here on purpose: an abandoned checkout must never stop
--     a retry.
--
--   * Packs had no lock, no "already own it" check and no duplicate protection at all: the edge
--     function inserted a fresh pending row per call. create_pack_purchase_locked() below gives
--     packs the same lock + already-owned check books have, plus the same 15-second guard, and
--     makes the free-pack path idempotent (a second call returns the existing $0 row instead of
--     inserting another).
--
-- Deliberately NOT added: a unique index on successful book/pack purchases. If two payments for
-- the same item ever do both succeed at Paystack, paystack-webhook must still be able to mark the
-- second one 'success'; a unique index would make that UPDATE fail on every delivery (the webhook
-- answers 5xx so Paystack retries forever) while the money is already taken. Duplicates are
-- prevented here, and DETECTED by the webhook's duplicate-charge alert instead.
--
-- Signatures: create_purchase_locked is unchanged (create or replace, existing grants carry
-- over). create_pack_purchase_locked is new. Both are service_role-only. No rows are touched, so
-- the migration is safe to re-run.
--
-- Deploy order: this migration first, then paystack-init-purchase and
-- paystack-init-pack-purchase (the pack function must be switched to call
-- create_pack_purchase_locked; until then packs keep behaving as before).
--
-- Optional pre-flight (existing double charges you may want to refund by hand):
--   select buyer_id, book_id, count(*) from purchases
--    where kind = 'book' and status = 'success' group by 1, 2 having count(*) > 1;
--   select buyer_id, pack_id, count(*) from purchases
--    where kind = 'pack' and status = 'success' and amount_kobo > 0 group by 1, 2 having count(*) > 1;
-- ============================================================================================

create or replace function create_purchase_locked(
  p_buyer_id uuid,
  p_author_id uuid,
  p_kind text,
  p_book_id text,
  p_reference text,
  p_amount_kobo bigint,
  p_author_amount_kobo bigint
)
returns purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row purchases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  -- Migration 115: defense in depth behind paystack-init-purchase's own author check.
  if p_buyer_id = p_author_id then
    raise exception 'A buyer cannot purchase or tip their own book.';
  end if;
  if p_kind not in ('book', 'tip') then
    raise exception 'Invalid purchase kind.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if p_author_amount_kobo is null or p_author_amount_kobo < 0 then
    raise exception 'Invalid author amount.';
  end if;

  if p_kind = 'book' then
    if p_book_id is null then
      raise exception 'A book purchase requires a book id.';
    end if;

    -- Serializes every concurrent purchase-init attempt by this buyer against this exact book —
    -- closes the double-charge race where two concurrent calls (two tabs, a double-tap Buy)
    -- could both pass the "not already owned" check before either had inserted its own pending
    -- row. Released automatically at the end of this function's transaction.
    perform pg_advisory_xact_lock(hashtext('purchase_init:' || p_buyer_id::text || ':' || p_book_id));

    if exists (
      select 1 from purchases
      where buyer_id = p_buyer_id and book_id = p_book_id and kind = 'book' and status = 'success'
    ) then
      raise exception 'You already own this book — no need to pay again.';
    end if;

    -- Migration 144: a second init for the same book a few seconds after the first is a
    -- double-tap or a second tab, not a real retry — refuse it. Anything older is left to the
    -- edge function's Paystack verification, so an abandoned checkout never blocks a retry.
    if exists (
      select 1 from purchases
      where buyer_id = p_buyer_id and book_id = p_book_id and kind = 'book' and status = 'pending'
        and created_at > now() - interval '15 seconds'
    ) then
      raise exception 'You already have a payment in progress for this book — please try again in a few seconds.';
    end if;
  end if;

  insert into purchases (
    paystack_reference, buyer_id, author_id, kind, book_id, amount_kobo, author_amount_kobo, status
  ) values (
    p_reference, p_buyer_id, p_author_id, p_kind, p_book_id, p_amount_kobo, p_author_amount_kobo, 'pending'
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function create_purchase_locked(uuid, uuid, text, text, text, bigint, bigint) from public;

-- --------------------------------------------------------------------------------------------
-- Worldbuilding Packs: the same lock + already-owned + double-tap protection books have.
--
-- Paid pack (p_amount_kobo > 0): inserts a 'pending' row; refuses if the buyer already owns the
-- pack ('success' row) or has another pending row for it younger than 15 seconds.
-- Free pack (p_amount_kobo = 0): inserts an already-settled ('success', $0) row — that row is
-- what published_pack_content's RLS checks for — and is idempotent: if the buyer already owns the
-- pack it returns the existing row instead of inserting another.
-- --------------------------------------------------------------------------------------------

create or replace function create_pack_purchase_locked(
  p_buyer_id uuid,
  p_author_id uuid,
  p_pack_id text,
  p_reference text,
  p_amount_kobo bigint,
  p_author_amount_kobo bigint
)
returns purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pack published_packs%rowtype;
  v_row purchases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_buyer_id is null or p_author_id is null or p_pack_id is null or p_reference is null then
    raise exception 'Missing purchase details.';
  end if;
  if p_buyer_id = p_author_id then
    raise exception 'A buyer cannot purchase their own pack.';
  end if;
  if p_amount_kobo is null or p_amount_kobo < 0 then
    raise exception 'Amount must not be negative.';
  end if;
  if p_author_amount_kobo is null or p_author_amount_kobo < 0 or p_author_amount_kobo > p_amount_kobo then
    raise exception 'Invalid author amount.';
  end if;

  -- Defense in depth behind paystack-init-pack-purchase (which bypasses RLS): an unlisted or
  -- missing pack cannot be sold, and the author must be the listing's real author.
  select * into v_pack from published_packs where id = p_pack_id;
  if not found or v_pack.unlisted then
    raise exception 'Pack not found';
  end if;
  if v_pack.author_id <> p_author_id then
    raise exception 'Invalid pack author.';
  end if;

  perform pg_advisory_xact_lock(hashtext('purchase_init:' || p_buyer_id::text || ':' || p_pack_id));

  select * into v_row from purchases
  where buyer_id = p_buyer_id and pack_id = p_pack_id and kind = 'pack' and status = 'success'
  order by created_at
  limit 1;
  if found then
    if p_amount_kobo = 0 then
      return v_row; -- free pack, already owned: idempotent replay, not an error
    end if;
    raise exception 'You already own this pack — no need to pay again.';
  end if;

  if p_amount_kobo > 0 and exists (
    select 1 from purchases
    where buyer_id = p_buyer_id and pack_id = p_pack_id and kind = 'pack' and status = 'pending'
      and created_at > now() - interval '15 seconds'
  ) then
    raise exception 'You already have a payment in progress for this pack — please try again in a few seconds.';
  end if;

  insert into purchases (
    paystack_reference, buyer_id, author_id, kind, pack_id, amount_kobo, author_amount_kobo, status, paid_at
  ) values (
    p_reference, p_buyer_id, p_author_id, 'pack', p_pack_id, p_amount_kobo, p_author_amount_kobo,
    case when p_amount_kobo = 0 then 'success' else 'pending' end,
    case when p_amount_kobo = 0 then now() else null end
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function create_pack_purchase_locked(uuid, uuid, text, text, bigint, bigint) from public;

-- Both functions are service_role-only (they check auth.role() themselves). Supabase's default
-- privileges also grant EXECUTE on new functions to anon/authenticated, which `from public` does not
-- remove (same gap migration 143 closed for refund_guild_event_escrow_contributors) — so revoke
-- those explicitly. Only the edge functions (service_role) call these.
revoke all on function create_purchase_locked(uuid, uuid, text, text, text, bigint, bigint) from anon, authenticated;
revoke all on function create_pack_purchase_locked(uuid, uuid, text, text, bigint, bigint) from anon, authenticated;
