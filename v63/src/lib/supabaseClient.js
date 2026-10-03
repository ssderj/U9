import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether real sync/guild/social features can work this session. Checked by callers that want
// to skip a network call entirely rather than let it fail; every other call site already
// catches its own errors, so this alone doesn't need to change much elsewhere.
export const isSupabaseConfigured = !!(url && anonKey);

if (!isSupabaseConfigured) {
  // Warn, don't throw — a throw here happens at module-load time, before React ever renders,
  // which took the entire app down to a blank screen in production when the env vars were
  // missing (see .env.example for what to set). Every real feature behind this client already
  // fails safely on its own (local-only fallback in FiresideBoard/GuildBookFeedbackModal,
  // caught .catch()s in the sync/profile/guild helpers) — the app just needs to finish loading
  // first.
  console.warn(
    'Inkroot: missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY \u2014 running fully offline, no account sync. Copy .env.example to .env.local (or set these in your host\'s project settings) and redeploy to enable sync.'
  );
}

// Sync requests (kv_store only) get a timeout. fetch() has none by default, and a request left hanging by a
// flaky or backgrounded mobile connection never settles, so syncEngine's `syncing` flag stayed true for the
// rest of the page load and nothing synced again until a reload. An aborted request surfaces as an error with
// no SQLSTATE code, which syncEngine already treats as transient (keep the outbox, retry on the next trigger).
// Generous because a project row can be several MB: 4 min for writes, 2 min for reads. Every other request is
// left exactly as it was.
const KV_WRITE_TIMEOUT_MS = 240000;
const KV_READ_TIMEOUT_MS = 120000;
function fetchWithKvTimeout(input, init) {
  const target = typeof input === 'string' ? input : ((input && input.url) || '');
  if (typeof AbortController === 'undefined' || !target.includes('/rest/v1/kv_store')) return fetch(input, init);
  const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), method === 'GET' || method === 'HEAD' ? KV_READ_TIMEOUT_MS : KV_WRITE_TIMEOUT_MS);
  const outer = init && init.signal;
  if (outer) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return fetch(input, Object.assign({}, init, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
}

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder-anon-key',
  // Required to use auth.registerPasskey()/signInWithPasskey() — see src/lib/auth.js. Passkey
  // support in supabase-js is still experimental, hence the explicit opt-in rather than it just
  // being on by default.
  { auth: { experimental: { passkey: true } }, global: { fetch: fetchWithKvTimeout } }
);

// Shared by every lib module that needs to check "who's signed in, if anyone" before a call
// (profile.js, library.js, library-guild.js, player-guild.js, guild-progression-remote.js) —
// each used to define its own identical local copy of this. Returns null when signed out rather
// than throwing, matching how every caller already used it.
//
// Uses getSession() (reads the session supabase-js already has in memory/localStorage, no
// network call) rather than getUser() (always round-trips to the Auth server to re-verify the
// token). Every one of the ~15 call sites below was paying that round trip just to read
// `user.id` before doing the real work — getSession()'s copy of the user is exactly as trustworthy
// for that: the server-side RLS check on the actual write/read still verifies the JWT itself, so
// nothing here is a security downgrade, just a client-side read of data already in memory.
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user || null;
}

