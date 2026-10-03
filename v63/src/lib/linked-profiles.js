import { supabase } from './supabaseClient.js';
import { sanitizeError } from './errors.js';
import { withTimeout } from './payments.js';

// Admin-only for now (see linked-profiles-admin-only-spec.md) — a linked profile is a real,
// separate auth.users row pseudonymously tied to one main account, restricted only from Player
// Guild functions (see 163_migration_gate_linked_profiles_from_player_guilds.sql). Everything
// here talks to the create-linked-profile / switch-profile Edge Functions and the
// list_my_linked_profiles() RPC (migration 190); real enforcement is server-side (RLS + the two
// RPCs those functions call) regardless of what this file does.

const REQUEST_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MESSAGE = 'This is taking longer than expected. Please try again.';

async function invoke(name, body) {
    const { data, error } = await withTimeout(supabase.functions.invoke(name, { body }), REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MESSAGE);
    if (error) {
        const detail = await error.context?.json?.().catch(() => null);
        if (detail?.error) throw new Error(detail.error);
        throw sanitizeError(error);
    }
    if (data?.error) throw new Error(data.error);
    return data;
}

// The accounts linked to the signed-in account, in every direction: if this account is a main,
// its secondaries; if it's a secondary, its one main AND its sibling secondaries (the other
// profiles under the same main). All of it comes from list_my_linked_profiles() (migration 190),
// a no-argument security-definer function that derives the roster from auth.uid() — a secondary
// can't read its siblings' rows straight off linked_profiles (that table's own RLS only shows an
// account the links it is itself part of), and this never returns another account's roster.
// Signed out: an empty roster, not an error.
export async function fetchMyLinkedProfiles() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { asMain: [], asSecondary: null, siblings: [] };

    const { data, error } = await withTimeout(supabase.rpc('list_my_linked_profiles'), REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MESSAGE);
    if (error) throw sanitizeError(error);

    const rows = data || [];
    const toEntry = (r) => ({ id: r.id, name: r.name, createdAt: r.created_at });
    const byCreated = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
    const main = rows.find((r) => r.relation === 'main');
    return {
        asMain: rows.filter((r) => r.relation === 'secondary').map(toEntry).sort(byCreated),
        asSecondary: main ? { id: main.id, name: main.name } : null,
        siblings: rows.filter((r) => r.relation === 'sibling').map(toEntry).sort(byCreated),
    };
}

// Admin-only — create-linked-profile's own Edge Function re-checks is_platform_admin
// server-side regardless of who calls this.
export async function createLinkedProfile(penName) {
    return invoke('create-linked-profile', { penName });
}

// Switches this session into a linked profile (main -> secondary, secondary -> main, or sibling
// secondaries under the same main). Resolves once the new session is active; the app's existing
// auth-state listener (shell/sync-context.jsx) picks up the change from there the same way it
// already does after any sign-in.
export async function switchToLinkedProfile(targetId) {
    const { tokenHash, email } = await invoke('switch-profile', { targetId });
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: 'email' });
    if (error || !data.session) throw sanitizeError(error, 'Could not switch profiles right now.');
    return data.session;
}
