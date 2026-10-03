-- 194_migration_pin_search_path_and_revoke_anon_writes.sql
--
-- NOT YET APPLIED TO LIVE. Review, then apply once.
--
-- Two audit follow-ups, both hardening only (no logic change):
--
-- 1. Pin search_path on every public function that still has none (Supabase advisor lint 0011,
--    "Function Search Path Mutable"). Same fix and same convention as 96b / 159:
--    `set search_path = public`. The loop picks the functions up from pg_proc instead of a
--    hard-coded list, so it matches live exactly. It aborts unless the count is the 17 found
--    in the audit, so a surprise (more or fewer) stops the migration instead of altering
--    something unreviewed. Extension-owned functions are skipped.
--
-- 2. Revoke INSERT, UPDATE, DELETE and TRUNCATE on public tables from anon. Supabase's default
--    privileges hand anon full table rights; RLS was the only thing stopping a signed-out write.
--    Checked before writing this: every INSERT/UPDATE/DELETE/ALL policy in schema.sql requires
--    auth.uid() or an is_*() check, so none can succeed for anon today; the client only writes
--    tables as a signed-in user; the one signed-out write path, record_book_view(), is
--    SECURITY DEFINER (runs as owner, unaffected by this revoke) and book_view_events is
--    already revoked from anon; edge functions use the service role. SELECT is untouched, so
--    public reads (Grand Library etc.) keep working. Default privileges are changed too so new
--    tables don't regrant anon write rights.

do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.prokind in ('f', 'p')
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%'
      )
      and not exists (
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('alter function %s set search_path = public', r.sig);
    n := n + 1;
  end loop;

  if n <> 17 then
    raise exception 'Expected to pin search_path on 17 functions, found %. Nothing applied; re-check the list.', n;
  end if;
end;
$$;

revoke insert, update, delete, truncate on all tables in schema public from anon;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate on tables from anon;
