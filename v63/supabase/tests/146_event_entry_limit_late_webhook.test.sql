-- ============================================================================================
-- Test for migration 146 (supabase/history/146_migration_event_entry_limit_late_webhook.sql)
-- — apply_guild_event_entry_payment() and the participant_limit.
--
-- How to run: same as supabase/tests/140_–145_: scratch/dev database with supabase/schema.sql
-- applied through migration 146, as a role that bypasses RLS (postgres), SQL editor or
-- `psql -f`. One transaction that ROLLS BACK; a failing case raises 'FAIL: ...' and aborts; a
-- clean run ends with 'PASS: ...'. Not for production (inserts, then rolls back, auth.users rows).
--
-- NOTE: written without a database to run it against. If the guild_events insert below trips a
-- NOT NULL / check added by a later migration, add the missing column to that one insert.
--
-- Seed: one guild-hosted event with participant_limit = 2; entrants A, B, C, D.
--
-- Cases:
--   1. unknown reference                                   -> 'unmatched'
--   2. A pays inside its 30-minute hold                    -> 'success', paid_at set
--   3. same reference delivered again                      -> 'already_applied'
--   4. B's hold expired, event has room (1 of 2)           -> 'success'
--   5. C's hold expired, event now full (2 of 2)           -> 'over_limit'; row is 'failed'
--   6. C's reference delivered again                       -> 'not_pending' (no revival)
--   7. D pays inside a fresh hold while the event is full  -> 'success' (it holds its own slot)
--   8. event with no participant_limit, expired hold       -> 'success'
--   9. non-service_role caller                             -> refused
-- ============================================================================================

begin;

create function pg_temp.act_as(p_role text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.role', coalesce(p_role, ''), true);
  perform set_config('request.jwt.claims', json_build_object('role', p_role)::text, true);
end;
$$;

do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  g uuid := gen_random_uuid(); ev uuid := gen_random_uuid(); ev_open uuid := gen_random_uuid();
  r text; st text; msg text;
begin
  insert into auth.users (id) values (a), (b), (c), (d);
  insert into player_guilds (id, name, owner_id) values (g, 'Test Guild 146', a);
  insert into guild_events (id, guild_id, host, title, entry_fee_kobo, participant_limit)
  values (ev, g, 'guild', 'Limited 146', 1000, 2), (ev_open, g, 'guild', 'Unlimited 146', 1000, null);

  perform pg_temp.act_as('service_role');

  r := apply_guild_event_entry_payment('ref-146-nope');
  if r <> 'unmatched' then raise exception 'FAIL (1): expected unmatched, got %', r; end if;

  -- A: fresh hold.
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, created_at)
  values (ev, a, 'ref-146-a', 1000, 900, 'pending', now());
  r := apply_guild_event_entry_payment('ref-146-a');
  if r <> 'success' then raise exception 'FAIL (2): expected success, got %', r; end if;
  if (select paid_at from guild_event_entries where paystack_reference = 'ref-146-a') is null then
    raise exception 'FAIL (2): paid_at not set';
  end if;

  r := apply_guild_event_entry_payment('ref-146-a');
  if r <> 'already_applied' then raise exception 'FAIL (3): expected already_applied, got %', r; end if;

  -- B: expired hold, 1 of 2 taken.
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, created_at)
  values (ev, b, 'ref-146-b', 1000, 900, 'pending', now() - interval '2 hours');
  r := apply_guild_event_entry_payment('ref-146-b');
  if r <> 'success' then raise exception 'FAIL (4): expected success, got %', r; end if;

  -- C: expired hold, event full.
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, created_at)
  values (ev, c, 'ref-146-c', 1000, 900, 'pending', now() - interval '2 hours');
  r := apply_guild_event_entry_payment('ref-146-c');
  if r <> 'over_limit' then raise exception 'FAIL (5): expected over_limit, got %', r; end if;
  select status into st from guild_event_entries where paystack_reference = 'ref-146-c';
  if st <> 'failed' then raise exception 'FAIL (5): over-limit row should be failed, is %', st; end if;

  r := apply_guild_event_entry_payment('ref-146-c');
  if r <> 'not_pending' then raise exception 'FAIL (6): expected not_pending, got %', r; end if;

  -- D: fresh hold, event full of successes — it still holds its own slot.
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, created_at)
  values (ev, d, 'ref-146-d', 1000, 900, 'pending', now());
  r := apply_guild_event_entry_payment('ref-146-d');
  if r <> 'success' then raise exception 'FAIL (7): expected success, got %', r; end if;

  -- Unlimited event, expired hold.
  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status, created_at)
  values (ev_open, c, 'ref-146-open', 1000, 900, 'pending', now() - interval '2 hours');
  r := apply_guild_event_entry_payment('ref-146-open');
  if r <> 'success' then raise exception 'FAIL (8): expected success, got %', r; end if;

  -- Non-service_role caller.
  perform pg_temp.act_as('authenticated');
  begin
    perform apply_guild_event_entry_payment('ref-146-b');
    raise exception 'FAIL (9): authenticated caller was allowed';
  exception when others then
    get stacked diagnostics msg = message_text;
    if msg not like '%Not authorized.%' then raise exception 'FAIL (9): unexpected error: %', msg; end if;
  end;

  raise notice 'PASS: migration 146 apply_guild_event_entry_payment cases 1-9';
end;
$$;

rollback;
