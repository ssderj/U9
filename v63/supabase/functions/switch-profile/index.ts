// Switches the caller's session to a linked profile (main -> secondary, secondary -> main, or
// secondary -> sibling secondary), without a second login. See
// linked-profiles-admin-only-spec.md section 3 for the original design; the token-minting
// approach here deliberately differs from that draft — see the comment above generateLink below.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Inlined from supabase/functions/_shared/payments.ts rather than imported — see
// create-linked-profile/index.ts's identical comment. Keep this block in sync with that file.
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
    const { client, user } = await requireUser(req);
    const { targetId } = await req.json();
    if (!targetId || typeof targetId !== 'string') throw new Error('No target profile given.');
    if (targetId === user.id) throw new Error('You\u2019re already signed in as that profile.');

    // Runs as the CALLER (client, not the service client) so auth.uid() inside
    // can_switch_to_linked_profile() is the real switcher — this is the one authorization check
    // that matters here: it accepts caller-is-main + target-is-a-secondary, caller-is-secondary +
    // target-is-their-main, and caller/target as sibling secondaries under the same main. See
    // 162_migration_linked_profiles.sql.
    const { data: allowed, error: checkErr } = await client.rpc('can_switch_to_linked_profile', {
      target_id: targetId,
    });
    if (checkErr) throw checkErr;
    if (!allowed) throw new Error('That profile isn\u2019t linked to your account.');

    const db = serviceClient();
    const { data: targetUser, error: targetErr } = await db.auth.admin.getUserById(targetId);
    if (targetErr || !targetUser?.user?.email) throw new Error('Linked profile not found.');

    // Deliberately NOT hand-signing a JWT with SUPABASE_JWT_SECRET and inserting a matching row
    // into auth.refresh_tokens directly (an earlier draft of this spec described exactly that).
    // That approach has to reconstruct GoTrue's internal claim/refresh-token-row shape by hand,
    // which is undocumented, private to GoTrue's own implementation, and free to change between
    // Supabase platform versions with no notice to us. generateLink() + verifyOtp() below is the
    // supported way to mint a session for an arbitrary user from the Admin API: generateLink
    // issues a genuine one-time token through GoTrue itself (so it's already valid by GoTrue's
    // own rules), and the client verifies it via verifyOtp — the exact call
    // supabase.auth.setSession() is only ever used for after a normal sign-in — to get back a
    // real { access_token, refresh_token } pair. No email is ever sent; this token is consumed
    // immediately, server-side to client, and never delivered anywhere.
    const { data: link, error: linkErr } = await db.auth.admin.generateLink({
      type: 'magiclink',
      email: targetUser.user.email,
    });
    if (linkErr || !link?.properties?.hashed_token) {
      throw new Error(sanitizeError(linkErr, 'Could not switch profiles right now.'));
    }

    // Logged before returning the token, using the CALLER's own auth.uid() (same client as the
    // authorization check above) — this is the one place impersonation-shaped code exists in the
    // app, so it should leave a trail regardless of what the client does with the token next.
    await client.rpc('record_profile_switch', { target_id: targetId });

    return jsonResponse({
      tokenHash: link.properties.hashed_token,
      email: targetUser.user.email,
    });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
