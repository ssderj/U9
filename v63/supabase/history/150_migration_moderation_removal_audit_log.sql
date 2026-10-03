-- Migration 150: moderator content removal/restoration now goes through one audited RPC
-- (adversarial audit finding #4).
--
-- The gap: a moderator flips removed_by_moderator on published_books, fireside_posts, reviews,
-- guild_book_feedback, or book_discussion_posts (migration 78) via a plain client UPDATE.
-- protect_content_from_moderator_edits() correctly stops a moderator changing anything ELSE on
-- someone else's row, but the removal flip itself was never routed through record_admin_action()
-- — every genuinely financial admin action (settle_manual_withdrawal, revoke_platform_role, event
-- approve/reject, force-cancel) writes to the append-only admin_audit_log; this didn't. No record
-- of who removed what, when, or why beyond the row's own updated_at, which a later flip overwrites.
--
-- The fix, in two parts:
--   1. moderator_set_content_removed(p_table, p_id, p_removed, p_reason) — one security-definer
--      RPC covering all five tables. Requires is_moderator, requires a non-empty p_reason when
--      removing (optional when restoring, matching the audit's own spec), performs the update,
--      and calls record_admin_action('remove_content' / 'restore_content', ...) in the same
--      transaction. published_books.id is text (not uuid, e.g. 'anthology-<uuid>' for a Guild
--      Anthology per publish_guild_anthology()) so admin_audit_log.target_id is left null for
--      that table only and the id travels in previous_state/new_state instead, same as every
--      other table for consistency.
--   2. protect_content_from_moderator_edits() (the shared trigger already attached to all five
--      tables, one function, five TG_ARGV[0] author-column variants — redefined in place, not a
--      second copy) gains one more check, alongside its existing "moderator may only touch
--      removed_by_moderator" rule: a change to removed_by_moderator itself is now rejected for
--      EVERY caller — moderator or not — unless a transaction-local flag is set. Only
--      moderator_set_content_removed() sets that flag, the same narrow, is_local = true
--      set_config pattern admin_set_login_ban and admin_revoke_platform_role already use for
--      their own trusted-RPC bypasses. This is what actually closes the "call the table directly"
--      gap the audit called out — the existing "moderators remove X" RLS UPDATE policies are left
--      in place unchanged (a moderator can still satisfy RLS), but the trigger now refuses the
--      column change outright unless it came from the RPC.
--
-- Not retroactive: existing removed_by_moderator values and their history (or lack of one) are
-- untouched. This only changes how the column can be changed from here on.

create or replace function moderator_set_content_removed(p_table text, p_id text, p_removed boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_mod boolean;
  v_target_id uuid;
  v_prev boolean;
  v_clean_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select is_moderator into v_is_mod from profiles where id = auth.uid();
  if not coalesce(v_is_mod, false) then
    raise exception 'Only a moderator can remove or restore content.';
  end if;
  if p_table not in ('published_books', 'fireside_posts', 'reviews', 'guild_book_feedback', 'book_discussion_posts') then
    raise exception 'Unknown content table.';
  end if;
  if p_removed and v_clean_reason is null then
    raise exception 'A reason is required to remove content.';
  end if;

  perform set_config('inkroot.trusted_moderation_rpc', 'true', true);

  if p_table = 'published_books' then
    select removed_by_moderator into v_prev from published_books where id = p_id;
    if not found then raise exception 'Content not found.'; end if;
    update published_books set removed_by_moderator = p_removed where id = p_id;
    v_target_id := null;
  elsif p_table = 'fireside_posts' then
    select removed_by_moderator into v_prev from fireside_posts where id = p_id::uuid;
    if not found then raise exception 'Content not found.'; end if;
    update fireside_posts set removed_by_moderator = p_removed where id = p_id::uuid;
    v_target_id := p_id::uuid;
  elsif p_table = 'reviews' then
    select removed_by_moderator into v_prev from reviews where id = p_id::uuid;
    if not found then raise exception 'Content not found.'; end if;
    update reviews set removed_by_moderator = p_removed where id = p_id::uuid;
    v_target_id := p_id::uuid;
  elsif p_table = 'guild_book_feedback' then
    select removed_by_moderator into v_prev from guild_book_feedback where id = p_id::uuid;
    if not found then raise exception 'Content not found.'; end if;
    update guild_book_feedback set removed_by_moderator = p_removed where id = p_id::uuid;
    v_target_id := p_id::uuid;
  else
    select removed_by_moderator into v_prev from book_discussion_posts where id = p_id::uuid;
    if not found then raise exception 'Content not found.'; end if;
    update book_discussion_posts set removed_by_moderator = p_removed where id = p_id::uuid;
    v_target_id := p_id::uuid;
  end if;

  perform record_admin_action(
    case when p_removed then 'remove_content' else 'restore_content' end,
    p_table,
    v_target_id,
    jsonb_build_object('id', p_id, 'removed_by_moderator', v_prev),
    jsonb_build_object('id', p_id, 'removed_by_moderator', p_removed),
    null,
    v_clean_reason
  );
end;
$$;

revoke all on function moderator_set_content_removed(text, text, boolean, text) from public;
grant execute on function moderator_set_content_removed(text, text, boolean, text) to authenticated;

-- protect_content_from_moderator_edits() — redefined in place (same trigger, same five tables,
-- same TG_ARGV[0] author-column argument per table) to add the removed_by_moderator lockdown.
create or replace function protect_content_from_moderator_edits()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  acting_is_moderator boolean;
  author_column text := TG_ARGV[0];
  old_owner uuid;
begin
  select p.is_moderator into acting_is_moderator from profiles p where p.id = auth.uid();
  execute format('select ($1).%I', author_column) into old_owner using old;

  if coalesce(acting_is_moderator, false) and auth.uid() is distinct from old_owner then
    if (to_jsonb(new) - 'removed_by_moderator') is distinct from (to_jsonb(old) - 'removed_by_moderator') then
      raise exception 'A moderator acting on someone else''s content may only change removed_by_moderator.';
    end if;
  end if;

  -- Migration 150: removed_by_moderator itself may now only change via
  -- moderator_set_content_removed(), so every removal/restoration is audit-logged. A direct
  -- client UPDATE — moderator or not, own content or not — can no longer flip this column
  -- outside that RPC.
  if new.removed_by_moderator is distinct from old.removed_by_moderator
     and coalesce(current_setting('inkroot.trusted_moderation_rpc', true), '') <> 'true' then
    raise exception 'removed_by_moderator can only be changed via moderator_set_content_removed().';
  end if;

  return new;
end;
$$;
