# Migration 190 — linked profile switcher: two-account checklist

Hand-run, not SQL. Needs a platform admin (main) account and at least TWO linked profiles created
from it (A and B). Apply `supabase/history/190_migration_list_my_linked_profiles.sql` first.

## SQL (SQL editor, as postgres)
1. `select has_function_privilege('anon', 'is_linked_profile(uuid)', 'execute');` -> `false`
   (and the same for `'authenticated'`). Before 190 this was `true`: any caller could ask whether any
   user id was a linked profile.
2. `select has_function_privilege('authenticated', 'list_my_linked_profiles()', 'execute');` -> `true`;
   same check with `'anon'` -> `false`.

## In the app
3. Signed in as the main (admin): Writer Profile shows the "Linked Profiles" button. The screen lists A
   and B under "YOUR LINKED PROFILES" and shows the create form.
4. Tap "Switch to" on A. App reloads signed in as A.
5. As A: Writer Profile shows the "Linked profile · Switch profile" pill (and no second Linked Profiles
   button). A is not an admin, so none of the admin buttons appear.
6. Open it: banner "You're on a linked profile"; main name is masked as dots until "Show" is tapped, and
   masked again after leaving and reopening the screen. B is listed under "OTHER LINKED PROFILES".
   The create form is NOT shown.
7. Tap "Switch to" on B -> reload as B. Tap "Switch back to main" -> reload as the main.
8. An ordinary account with no links (a third test account): no Linked Profiles button, no pill.
9. Another user's Author's Hall for A or the main never shows the pill or any link wording.
10. While A is signed in, call `supabase.rpc('is_linked_profile', { check_user_id: '<main id>' })` from
    the browser console -> permission denied error, not a boolean.
