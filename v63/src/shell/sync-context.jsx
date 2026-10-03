import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { onAuthChange, getSession, signOut, signInWithGoogle, signInWithPasskey, registerPasskey } from '../lib/auth.js';
import { switchSyncUser, confirmAccountSwitch, clearSyncUser, fullResync, scheduleSync, flushOutbox, listConflictBackups, restoreConflictBackup, dismissConflictBackup } from '../lib/syncEngine.js';
import { storage } from '../lib/storage.js';
import { GUILD_KEY, projectKey } from '../shared-utils/storage-keys.jsx';
import { syncFounderGuildMembership } from '../lib/library-guild.js';
import { redeemPendingReferralCode } from '../lib/referrals.js';
import { dialogProps, useDialogBehavior } from './nav-context.jsx';

// Account sync used to be a floating "Sync · off" badge rendered by main.jsx on top of the whole
// app, outside its component tree entirely — which meant it showed up fixed in the corner of
// every single screen (Home, the Grand Library, a project workspace, the Guild Hall...) whether
// or not sync had anything to do with what was on screen. Moving the session/auth logic into a
// context here lets exactly one place — the Home dashboard, via AccountSyncControl in
// account-sync-control.jsx — render the actual control, while everything else can ignore it
// entirely. The session logic itself (onAuthChange wiring, the online-retry effect, sign-out,
// Google OAuth, passkeys) is unchanged from what main.jsx used to own directly.
// Everything that has to happen once a signed-in account's own data has been pulled onto this
// device — shared by the normal sign-in path and the "back up, then continue" account-switch path.
//
// FIX — dispatches 'inkroot:sync-pulled' once switchSyncUser's fullResync has actually finished
// writing this account's data into IndexedDB. ink-root.jsx's loadProjectIndex() only ever ran
// once, on mount — but SyncGate (main.jsx) renders the app as soon as the session is *known*,
// which races ahead of this fire-and-forget pull. On a fresh sign-in (or right after an account
// switch, which wipes local data first) that meant the project index got read from IndexedDB
// before the pull landed, came back empty, and nothing ever re-read it afterward — every project,
// including anything published (publishing.jsx renders published books from this same local
// project list), looked permanently gone even though it was safely in IndexedDB/Supabase seconds
// later. This event lets ink-root.jsx re-run loadProjectIndex() once the data is actually there.
async function runPostSwitchSteps(userId) {
    // Backfill: covers the common case of joining a Founder Guild while signed
    // out, then signing in later — ink-root.jsx's own load-time backfill only
    // catches a membership that's already local *when the app boots*, not one
    // that becomes attributable to an account only once sign-in happens after.
    // Reads GUILD_KEY post-resync (switchSyncUser already awaited pulling this
    // account's own remote data), so this reflects the signed-in account's own
    // guild membership, not a different account's leftover local state.
    try {
        const res = await storage.get(GUILD_KEY);
        const guildProfile = res && JSON.parse(res.value);
        if (guildProfile && guildProfile.guildType === 'founder' && guildProfile.founderGuildId) {
            await syncFounderGuildMembership(guildProfile.founderGuildId);
        }
    } catch (e) {
        console.warn('Inkroot: founder guild membership backfill failed', e);
    }

    // Fire-and-forget, same non-blocking philosophy as the backfill above.
    // redeemPendingReferralCode() itself no-ops when there's no locally-cached
    // code, and is safe to attempt on every sign-in (idempotent server-side) —
    // see src/lib/referrals.js.
    redeemPendingReferralCode();

    // Fired last, after the backfill/redeem steps above, so a listener that reacts to it (e.g.
    // re-reading the project index) sees fully-settled local data, not just "the kv rows landed".
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('inkroot:sync-pulled', { detail: { userId } }));
    }
}

// Writes every project still stored on this device to a JSON file in the same shape the Home
// screen's "Import backup" reads (see ink-root.jsx handleExportAll / handleImportFile), so work
// that only ever existed here can be restored after an account switch. Returns how many projects
// were written.
async function downloadLocalWorkBackup() {
    const keys = await storage.list(projectKey(''));
    const projects = [];
    for (const key of keys) {
        const res = await storage.get(key);
        if (!res) continue;
        try {
            const parsed = JSON.parse(res.value);
            // Skips sibling keys under the same prefix (e.g. a project's ':backups' list).
            if (parsed && Array.isArray(parsed.chapters)) projects.push(parsed);
        } catch (e) { /* not a project record */ }
    }
    const bundle = { exportedFrom: 'inkroot', exportedAt: new Date().toISOString(), projects };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inkroot-local-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    return projects.length;
}

// Shown when a different account signs in on a browser that still holds unsynced work from the
// previous one (see syncEngine.js doSwitchSyncUser). Nothing has been deleted at this point.
function AccountSwitchDialog({ pendingCount, onBackupAndContinue, onSignOut }) {
    const dlgRef = useDialogBehavior(null); // a forced choice: no Escape
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const run = async (fn) => {
        setBusy(true);
        setError('');
        try { await fn(); }
        catch (e) {
            console.warn('Inkroot: account switch step failed', e);
            setError('That didn\u2019t work \u2014 nothing has been deleted. Please try again.');
            setBusy(false);
        }
    };
    const button = (label, onClick, primary) => React.createElement("button", {
        disabled: busy, onClick,
        style: { padding: '11px 16px', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
            border: primary ? '1px solid #E8C468' : '1px solid #3A3A42', background: primary ? '#E8C468' : 'transparent', color: primary ? '#17171B' : '#EFE7D2' },
    }, label);
    return React.createElement("div", { ref: dlgRef, ...dialogProps('Different account signed in'), style: { position: 'fixed', inset: 0, zIndex: 100000, background: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 } },
        React.createElement("div", { style: { maxWidth: 440, width: '100%', background: '#1E1E24', border: '1px solid #3A3020', borderRadius: 14, padding: 22, color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui', display: 'flex', flexDirection: 'column', gap: 14 } },
            React.createElement("div", { style: { fontSize: 17, fontWeight: 700 } }, "This device has work that hasn\u2019t been synced"),
            React.createElement("div", { style: { fontSize: 14, lineHeight: 1.55, color: '#C9C2B0' } },
                `You signed in with a different account than the one this device last used, and ${pendingCount} change${pendingCount === 1 ? '' : 's'} from that account ${pendingCount === 1 ? 'was' : 'were'} never uploaded. Continuing will replace this device\u2019s local data with the new account\u2019s. Nothing has been deleted yet.`),
            React.createElement("div", { style: { fontSize: 13, color: '#8A8A92' } }, "Download a backup first \u2014 you can restore it later with Import backup on the Home screen."),
            error && React.createElement("div", { style: { fontSize: 13, color: '#E58A8A' } }, error),
            button('Download a backup, then continue', () => run(onBackupAndContinue), true),
            button('Sign out and keep this device\u2019s work', () => run(onSignOut), false)));
}

export const SyncContext = createContext(null);

export function useSync() {
    return useContext(SyncContext);
}

export function SyncProvider({ children }) {
    const [session, setSession] = useState(null);
    const [ready, setReady] = useState(false);
    const [oauthError, setOauthError] = useState('');
    const [justSignedIn, setJustSignedIn] = useState(false);
    // True once a session that existed during this page load ended without the person asking for
    // it (a revoked/expired refresh token, a sign-out in another tab, a banned account) — cleared
    // as soon as any session is established again. Audit finding #12: before this the app just
    // quietly went back to "signed out" — sync stopped with no word, while the person kept writing
    // believing it was still backed up. Editing is never blocked (local-first); this only tells
    // them. See account-sync-control.jsx and sync-status-indicator.jsx for where it's shown.
    const [sessionEnded, setSessionEnded] = useState(false);
    // { userId, pendingCount } while a different account's sign-in is waiting for the person to decide
    // what happens to unsynced local work; null otherwise. See AccountSwitchDialog above.
    const [accountSwitchBlocked, setAccountSwitchBlocked] = useState(null);
    // Set when Sign out is held back because recent changes could not be uploaded (see signOutByUser).
    const [signOutNotice, setSignOutNotice] = useState('');

    // FIX — shared bookkeeping between the explicit getSession() hydration and the
    // onAuthStateChange listener below (see the second useEffect for why both now exist). Both
    // can observe the very first real session of this page load, so this lives in refs rather
    // than a `let` local to just one of the two — that's what keeps "have we already marked the
    // app ready" / "have we already synced this user" consistent no matter which of the two
    // notices it first, instead of the two stepping on each other or double-firing switchSyncUser.
    const readyRef = useRef(false);
    const hadSessionRef = useRef(false);
    const syncedUserIdRef = useRef(null);
    // Set for the duration of a sign-out the person asked for (see signOutByUser below), so the
    // resulting null session isn't mistaken for a session that ended on its own.
    const userSignedOutRef = useRef(false);
    // The last account that was signed in this page load. A session for this SAME account coming
    // back after a gap (a token refresh after starting offline, a re-sign-in after the session
    // ended) is a continuation, not a new sign-in, so it doesn't get the "Signed in successfully"
    // confirmation. Cleared on a deliberate sign-out so signing back in afterwards still does.
    const lastUserIdRef = useRef(null);

    useEffect(() => {
        // Google OAuth is a redirect flow (see lib/auth.js's signInWithGoogle) — a rejection
        // (e.g. this account is login-banned) happens server-side, AFTER the redirect away and
        // back, so unlike passkey sign-in (see account-sync-control.jsx's handlePasskeySignIn)
        // it can't be caught as a thrown error at the signInWithGoogle() call site — that call
        // just starts the redirect and returns immediately. Supabase instead reports a rejection
        // by appending error/error_description to the redirect URL itself, so that's read here,
        // once, on load. The substring check below is a best effort, same caveat as the passkey
        // path: Supabase's exact error_description wording for a banned account isn't something
        // verifiable from this environment — check it against your own project if this matters.
        const params = new URLSearchParams(window.location.hash ? window.location.hash.slice(1) : window.location.search);
        const err = params.get('error_description') || params.get('error');
        if (err) {
            // URLSearchParams.get() has already percent-decoded this (and turned '+' into a space).
            // Decoding it a second time threw a URIError -- uncaught inside this effect, so it
            // blanked the whole app -- for any description containing a literal '%'.
            const decoded = err;
            // decoded here is a raw error_description straight from Supabase's own OAuth
            // redirect — used only to classify against the "banned" pattern below, never
            // displayed directly (see account-sync-control.jsx's handlePasskeySignIn for the
            // equivalent passkey-flow check and why the same rule applies there).
            setOauthError(/banned/i.test(decoded)
                ? "This account has been restricted from signing in. If you believe this is a mistake, please reach out to appeal."
                : "Something went wrong signing in with Google. Please try again.");
            // Scrubs the error out of the visible URL so reloading the page doesn't keep
            // re-showing it, and it doesn't linger visibly in the address bar.
            window.history.replaceState(null, '', window.location.pathname);
        } else if (params.get('code') || params.get('access_token')) {
            // FIX — a SUCCESSFUL Google return leaves `?code=...&state=...` (PKCE flow) or
            // `#access_token=...` (implicit flow) sitting in the address bar. supabase-js reads
            // and exchanges it automatically on load (see lib/auth.js) but never removes it from
            // the URL itself — only the error branch above ever did that. A PKCE auth code is
            // single-use and only valid for a few minutes (Supabase rejects a second exchange of
            // the same code), so leaving it in the URL meant refreshing the page right after
            // signing in resubmitted that already-used code, the second exchange silently
            // produced no session, and the app looked signed-out again — this is "logged in
            // works, but doesn't survive a refresh". Stripping it immediately, the same way the
            // error branch already did, fixes that: by the time this effect runs, the Supabase
            // client (constructed at module load, before React even mounts) has already read
            // whatever it needed from the URL — same timing the pre-existing error-cleanup line
            // above already relied on — so clearing it here doesn't race the exchange itself.
            window.history.replaceState(null, '', window.location.pathname);
        }
    }, []);

    useEffect(() => {
        // Single handler fed by two sources below — the explicit getSession() call and the
        // onAuthStateChange listener — so "did we already mark ready", "did we already show the
        // just-signed-in confirmation", and "did we already sync this user's data" all stay
        // correct regardless of which source notices a given session change first.
        const handleSession = (s) => {
            setSession(s);
            if (!readyRef.current) {
                readyRef.current = true;
                hadSessionRef.current = !!s;
                setReady(true);
            } else if (s && !hadSessionRef.current) {
                // A genuine sign-in completing DURING this page load — Google's redirect-back
                // landing, or a passkey prompt resolving — as opposed to already being signed in
                // when the app first booted (that's the branch above, which stays silent; nobody
                // needs a "you're signed in" toast every time they just open the app). This is
                // the fix for the actual confusion: Google OAuth redirects the whole page away
                // and back with zero visual continuity, so without an explicit confirmation here,
                // landing back on Home gives no sign whatsoever that anything happened — see
                // account-sync-control.jsx, which auto-opens the panel and shows this.
                hadSessionRef.current = true;
                if (lastUserIdRef.current !== s.user.id) setJustSignedIn(true);
            } else if (!s) {
                // Was signed in a moment ago, now isn't, and the person didn't ask for it.
                if (hadSessionRef.current && !userSignedOutRef.current) setSessionEnded(true);
                userSignedOutRef.current = false;
                hadSessionRef.current = false;
            }
            if (s) {
                lastUserIdRef.current = s.user.id;
                setSessionEnded(false);
                if (syncedUserIdRef.current === s.user.id) return; // already synced this user this load
                syncedUserIdRef.current = s.user.id;
                // Clears any other account's leftover local data first — unless that data was never
                // synced, in which case it reports { blocked: true } and asks the person (see
                // AccountSwitchDialog) instead of deleting it.
                switchSyncUser(s.user.id).then((result) => {
                    if (result && result.blocked) {
                        setAccountSwitchBlocked({ userId: s.user.id, pendingCount: result.pendingCount });
                        return;
                    }
                    return runPostSwitchSteps(s.user.id);
                }).catch((e) => {
                    // Without this, a failure here left syncedUserIdRef set, so this account was
                    // never retried for the rest of the page load.
                    console.warn('Inkroot: account sync setup failed', e);
                    if (syncedUserIdRef.current === s.user.id) syncedUserIdRef.current = null;
                });
            } else {
                syncedUserIdRef.current = null;
                clearSyncUser();
            }
        };

        let cancelled = false;
        // FIX — explicit getSession() call, IN ADDITION to the onAuthStateChange listener below
        // (previously the only source, see its own comment for what it still covers). The
        // original design relied solely on onAuthStateChange's first callback to already reflect
        // a session freshly restored from the Google OAuth redirect. getSession() and that first
        // callback are supposed to resolve to the same thing, but they're not guaranteed to be
        // consistent the moment this component mounts: getSession() always waits for the client's
        // pending initialize()/URL-code-exchange to finish before resolving, while the listener's
        // very first callback can fire from whatever session state the client already had
        // *before* that exchange completes — i.e. null. That's exactly "Google OAuth is now
        // working... but Inkroot does not recognize me as logged in": the redirect and exchange
        // both succeeded, but the app had already latched `ready = true` / signed-out off an
        // initial callback that ran a beat too early. Calling getSession() directly here always
        // waits for the real outcome, so it catches that exact case without removing the listener
        // itself, which is still what's needed for sign-out, a later sign-in, passkeys, and
        // cross-tab session changes.
        getSession().then((s) => {
            if (cancelled) return;
            handleSession(s);
        }).catch((e) => {
            // The whole app renders nothing until `ready` (see SyncGate), so a rejection here used
            // to leave a permanent blank screen. Treat it as "not signed in" and let the app open.
            console.warn('Inkroot: getSession failed', e);
            if (!cancelled) handleSession(null);
        });

        const unsubscribe = onAuthChange((s) => {
            if (cancelled) return;
            handleSession(s);
        });

        return () => { cancelled = true; unsubscribe(); };
    }, []);

    // Retry sync whenever the device comes back online — the outbox already holds anything
    // written while offline, this just stops it from waiting for the next local edit to flush.
    useEffect(() => {
        const handler = () => { if (session) fullResync(); };
        window.addEventListener('online', handler);
        return () => window.removeEventListener('online', handler);
    }, [session]);

    // Pull on coming back to the app, and on a slow timer while it is open. The only things that ever started a
    // sync were this device's own edits, the 'online' event and sign-in, so work saved from another device
    // arrived only whenever one of those happened to fire ("it shows up at a random time"). scheduleSync() is an
    // incremental push + metadata-only pull (no value download unless a key actually changed), so this is cheap.
    useEffect(() => {
        if (!session) return undefined;
        let last = 0;
        const kick = () => {
            if (document.hidden || !navigator.onLine) return;
            const now = Date.now();
            if (now - last < 20000) return;
            last = now;
            scheduleSync();
        };
        document.addEventListener('visibilitychange', kick);
        window.addEventListener('focus', kick);
        const timer = setInterval(kick, 60000);
        return () => {
            document.removeEventListener('visibilitychange', kick);
            window.removeEventListener('focus', kick);
            clearInterval(timer);
        };
    }, [session]);

    // Item 10 (fix tracker) — the recovery UI for syncEngine.js's own conflict-backup safety net.
    // backupLosingLocalEdit (syncEngine.js) already saves a losing local edit to IndexedDB's
    // conflictBackups store and fires 'inkroot:sync-conflict' whenever "remote wins" would
    // otherwise discard it silently; nothing was listening for that event until now. Loaded once
    // on mount (not just on the event) because a conflict can have been backed up during a
    // previous session/background sync, before anything was mounted to hear about it — the
    // writer should still see it the next time they open the app, not only if one happens to
    // occur while they're already looking at the screen.
    const [conflictBackups, setConflictBackups] = useState([]);
    const refreshConflictBackups = () => listConflictBackups().then(setConflictBackups).catch((e) => console.warn('Inkroot: listConflictBackups failed', e));
    useEffect(() => {
        refreshConflictBackups();
        const handler = () => refreshConflictBackups();
        window.addEventListener('inkroot:sync-conflict', handler);
        return () => window.removeEventListener('inkroot:sync-conflict', handler);
    }, []);
    const restoreConflict = (id) => restoreConflictBackup(id).then((ok) => { if (ok) refreshConflictBackups(); return ok; });
    const dismissConflict = (id) => dismissConflictBackup(id).then(refreshConflictBackups);

    // The person's own Sign out. Marks it as deliberate before the SIGNED_OUT event lands (see
    // handleSession) so it isn't reported as "session ended", and forgets the account so signing
    // back in afterwards is treated as a fresh sign-in. If the sign-out itself fails (supabase-js
    // returns `{ error }` and leaves the session in place) the mark is dropped again, so a real
    // session end later on is still reported.
    const signOutByUser = async () => {
        // Push anything still pending BEFORE the session goes (see flushOutbox). If it cannot be sent in time
        // (offline, server unreachable) sign-out is held back, not silently done: the work would sit on this
        // device only. The caller gets { error } like any failed sign-out and the message below is shown.
        // A second tap after that notice signs out anyway (the changes then stay on this device, and upload the
        // next time this account is signed in here), so an offline person is never locked into the session.
        const alreadyWarned = !!signOutNotice;
        setSignOutNotice('');
        try {
            const { pending } = alreadyWarned ? { pending: 0 } : await flushOutbox(20000);
            if (pending > 0) {
                const msg = `${pending} recent change${pending === 1 ? ' is' : 's are'} not backed up yet, so you were not signed out. Check your connection and try again, or tap Sign out again to sign out anyway (those changes stay on this device until you sign back in here).`;
                setSignOutNotice(msg);
                return { error: new Error(msg) };
            }
        } catch (e) { /* flushing is best-effort; fall through to a normal sign-out */ }
        userSignedOutRef.current = true;
        lastUserIdRef.current = null;
        try {
            const result = await signOut();
            if (result && result.error) userSignedOutRef.current = false;
            return result;
        } catch (e) {
            userSignedOutRef.current = false;
            throw e;
        }
    };

    const value = {
        session, ready, signOut: signOutByUser, sessionEnded, signInWithGoogle, signInWithPasskey, registerPasskey, oauthError, justSignedIn, clearJustSignedIn: () => setJustSignedIn(false),
        conflictBackups, restoreConflict, dismissConflict, signOutNotice,
    };
    const continueAfterBackup = async () => {
        const blocked = accountSwitchBlocked;
        if (!blocked) return;
        await downloadLocalWorkBackup();
        await confirmAccountSwitch(blocked.userId);
        setAccountSwitchBlocked(null);
        await runPostSwitchSteps(blocked.userId);
    };
    const signOutKeepingLocalWork = async () => {
        setAccountSwitchBlocked(null);
        syncedUserIdRef.current = null;
        await signOutByUser();
    };
    return React.createElement(SyncContext.Provider, { value },
        children,
        accountSwitchBlocked && React.createElement(AccountSwitchDialog, {
            pendingCount: accountSwitchBlocked.pendingCount,
            onBackupAndContinue: continueAfterBackup,
            onSignOut: signOutKeepingLocalWork,
        }));
}
