// Admin-gated creation of a linked (pseudonymous secondary) profile — see
// linked-profiles-admin-only-spec.md. This is the ONLY place that writes linked_profiles (the
// table has no client insert policy at all — see 162_migration_linked_profiles.sql), so the
// 25-row cap trigger on that table is the sole enforcement point; nothing here needs to stay in
// sync with it.
//
// Creating the actual auth.users row needs the service-role Admin API, which a plain Postgres
// RPC can't call — that's why this has to be an Edge Function rather than a security-definer SQL
// function like the rest of Inkroot's writes.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Inlined from supabase/functions/_shared/payments.ts rather than imported: this function is
// deployed independently and the deploy path used doesn't reliably resolve cross-function
// relative imports. Keep this block identical to _shared/payments.ts if that file changes.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export function callerClient(req: Request) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
  );
}

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

export async function requireUser(req: Request) {
  const client = callerClient(req);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in');
  return { client, user: data.user };
}

// Inlined rather than imported — same reason as callerClient/serviceClient above.
function sanitizeError(e: any, fallback = 'Something went wrong. Please try again.'): string {
  console.error('Inkroot function error:', e);
  if (!e || typeof e.message !== 'string' || !e.message) return fallback;
  if (e.code === 'P0001') return e.message;
  const name = typeof e.name === 'string' ? e.name : '';
  if (name && name !== 'Error') return fallback;
  const hasCode = typeof e.code === 'string' && e.code.length > 0;
  if (!name && hasCode) return fallback;
  return e.message;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  try {
    const { user } = await requireUser(req);
    const db = serviceClient();

    // is_platform_admin gate — same trust flag is_inkroot_admin() checks, looked up directly
    // here rather than via that function: a Postgres security-definer function reads auth.uid()
    // from the request's own JWT-scoped session, which this service-role client doesn't have, so
    // the check has to be done as a plain row lookup against the caller's own verified user.id
    // instead.
    const { data: callerProfile, error: profileErr } = await db.from('profiles')
      .select('is_platform_admin').eq('id', user.id).single();
    if (profileErr || !callerProfile?.is_platform_admin) {
      throw new Error('Only a platform admin can create a linked profile.');
    }

    const { penName } = await req.json();
    if (!penName || typeof penName !== 'string' || !penName.trim()) {
      throw new Error('Give the linked profile a pen name.');
    }
    const trimmedPenName = penName.trim().slice(0, 80);

    // Synthetic email — this address is never used to log in directly (sign-in only ever
    // happens through switch-profile's minted session, never a normal Google/passkey flow for
    // this auth.users row), so its exact form doesn't matter beyond being unique and valid.
    const syntheticEmail = `linked.${crypto.randomUUID()}@linked.inkroot.internal`;

    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email: syntheticEmail,
      email_confirm: true,
      user_metadata: { linked_to: user.id },
    });
    if (createErr || !created?.user) {
      throw new Error(sanitizeError(createErr, 'Could not create the linked account.'));
    }
    const secondaryId = created.user.id;

    // handle_new_user() / on_auth_user_created seeds this row the same as any normal signup —
    // nothing to do here except set the pen name once it exists. profiles rows are created by
    // that trigger asynchronously-in-transaction with createUser, so it's already there by now.
    const { error: penNameErr } = await db.from('profiles')
      .update({ pen_name: trimmedPenName }).eq('id', secondaryId);
    if (penNameErr) {
      // Roll back the auth.users row rather than leaving an orphaned, unlabeled linked account —
      // linked_profiles hasn't been written yet at this point, so this cleanup is safe.
      await db.auth.admin.deleteUser(secondaryId).catch((e) => console.error('Cleanup failed after pen_name error', e));
      throw new Error(sanitizeError(penNameErr, 'Could not set the linked profile\u2019s pen name.'));
    }

    // This insert is what the 25-row cap trigger (enforce_linked_profile_cap, migration 162)
    // guards — a cap failure here rolls back this statement only; the auth.users row already
    // exists, so on that failure we clean it up the same way as the pen_name failure above.
    const { error: linkErr } = await db.from('linked_profiles')
      .insert({ secondary_id: secondaryId, main_id: user.id, created_by: user.id });
    if (linkErr) {
      await db.auth.admin.deleteUser(secondaryId).catch((e) => console.error('Cleanup failed after link error', e));
      throw new Error(sanitizeError(linkErr, 'Could not link the new profile to your account.'));
    }

    return jsonResponse({ secondaryId, penName: trimmedPenName });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
