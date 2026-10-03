import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { fetchGuildEvents } from '../lib/guild-events.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { fetchFiresidePosts, fetchFounderGuildMembers, fetchGuildPublishedBooks, subscribeFiresideRealtime } from '../lib/library-guild.js';
import { fetchPlayerGuild, fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchPlatformAdminIds } from '../lib/moderation.js';
import { goRealPlayerRung } from './guild-order-core.jsx';

// ---------- Guild tab data, fetched once and shared ----------
// The Guild tab used to open several sections that each fetched their own data (events preview,
// notice board, anthology preview) while the closed folds fetched nothing, so a closed row could
// only show static text. This hook loads the small amounts of data the page needs for its live
// counts, the "Today in the Guild" strip and the Fireside "new" dot, in one place. Every slice
// starts as null ("not known yet") so callers show "—" or nothing rather than an invented number.
// No new backend: it only calls readers that already exist.
//
// Ids: events/anthologies key off `backendId` (the real player_guilds.id, or a Founder Guild's
// backendGuildId). Fireside posts key off `firesideId` (a Founder Guild's slug, or the real
// player_guilds.id) - the same id FiresideBoard posts under, so notices and the new-post count
// read the same rows the Fireside itself shows.
const OFFICER_RUNG_THRESHOLD = 4; // same officer-or-above cut the old NoticeBoard used
const SEEN_PREFIX = 'inkroot:guild:fireside-seen:';

function readSeen(id) { try { const v = Number(localStorage.getItem(SEEN_PREFIX + id)); return v > 0 ? v : 0; } catch (e) { return 0; } }
function writeSeen(id, t) { try { localStorage.setItem(SEEN_PREFIX + id, String(t)); } catch (e) { /* best-effort */ } }

const BADGE_POLL_MS = 45000; // same cadence as the Universe badge

export function useGuildHallData({ enabled, isFounderView, founderGuildId, backendId, firesideId, memberSourceId, viewingFireside, onGuildTab, inGuild }) {
    const [memberCount, setMemberCount] = useState(null);
    const [events, setEvents] = useState(null);
    const [anthologies, setAnthologies] = useState(null);
    const [posts, setPosts] = useState(null);
    const [notices, setNotices] = useState(null);
    const [bookIds, setBookIds] = useState(null);
    const [myId, setMyId] = useState(null);
    const [seenAt, setSeenAt] = useState(0);
    const [tabBadge, setTabBadge] = useState(0);

    useEffect(() => {
        let cancelled = false;
        supabase.auth.getUser().then(({ data }) => { if (!cancelled && data && data.user) setMyId(data.user.id); }).catch(() => { });
        return () => { cancelled = true; };
    }, []);

    // Real roster count. A Player Guild's owner can be missing from player_guild_members (the Roster
    // tab adds them by hand for the same reason), so count them once if their row is not there.
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setMemberCount(null);
        if (!memberSourceId) return;
        const run = isFounderView
            ? fetchFounderGuildMembers(memberSourceId).then((rows) => rows.length)
            : Promise.all([fetchPlayerGuildMembers(memberSourceId), fetchPlayerGuild(memberSourceId).catch(() => null)])
                .then(([rows, guildRow]) => {
                    const ownerId = guildRow && guildRow.owner_id;
                    return rows.length + (ownerId && !rows.some((r) => r.user_id === ownerId) ? 1 : 0);
                });
        run.then((n) => { if (!cancelled) setMemberCount(n); }).catch(() => { /* stays "—" */ });
        return () => { cancelled = true; };
    }, [enabled, isFounderView, memberSourceId]);

    // Events and anthologies: only a count and the running event are needed here.
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setEvents(null);
        setAnthologies(null);
        if (!backendId) return;
        fetchGuildEvents(backendId).then((rows) => { if (!cancelled) setEvents(rows); }).catch(() => { });
        fetchGuildAnthologies(backendId).then((rows) => { if (!cancelled) setAnthologies(rows); }).catch(() => { });
        return () => { cancelled = true; };
    }, [enabled, backendId]);

    // Books on the guild shelf (remote ids only; the caller merges this device's own).
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setBookIds(null);
        if (!firesideId) return;
        fetchGuildPublishedBooks(firesideId).then((rows) => { if (!cancelled) setBookIds(rows.map((b) => b.id)); }).catch(() => { });
        return () => { cancelled = true; };
    }, [enabled, firesideId]);

    // Fireside posts (live) -> total, new-since-last-seen, and the officer-authored announcements.
    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setPosts(null);
        setNotices(null);
        if (!firesideId) return;
        const load = () => {
            fetchFiresidePosts(firesideId).then(async ({ posts: rows }) => {
                const all = rows || [];
                if (cancelled) return;
                setPosts(all.map((p) => ({ id: p.id, author_id: p.author_id, created_at: p.created_at })));
                const announcements = all.filter((p) => p.category === 'announcement' && !p.parent_id);
                if (announcements.length === 0) { setNotices([]); return; }
                const authorIds = [...new Set(announcements.map((p) => p.author_id))];
                const rungByAuthor = {};
                if (isFounderView) {
                    const adminIds = await fetchPlatformAdminIds(authorIds).catch(() => new Set());
                    authorIds.forEach((id) => { rungByAuthor[id] = adminIds.has(id) ? 6 : 1; });
                }
                else {
                    const [members, guildRow] = await Promise.all([
                        fetchPlayerGuildMembers(firesideId).catch(() => []),
                        fetchPlayerGuild(firesideId).catch(() => null),
                    ]);
                    const roleByUserId = {};
                    (members || []).forEach((m) => { roleByUserId[m.user_id] = m.role; });
                    const ownerId = guildRow && guildRow.owner_id;
                    authorIds.forEach((id) => { rungByAuthor[id] = goRealPlayerRung(!!ownerId && id === ownerId, roleByUserId[id]); });
                }
                if (cancelled) return;
                setNotices(announcements
                    .filter((p) => (rungByAuthor[p.author_id] || 0) >= OFFICER_RUNG_THRESHOLD)
                    .map((p) => ({ ...p, rung: rungByAuthor[p.author_id] }))
                    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at)));
            }).catch((e) => {
                console.warn('Inkroot: guild hall data fetch failed', e);
                if (!cancelled) { setPosts(null); setNotices([]); }
            });
        };
        load();
        const unsubscribe = subscribeFiresideRealtime(firesideId, load);
        return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
    }, [enabled, isFounderView, firesideId]);

    // Per-device, per-guild "last seen the Fireside" time - same idea as the Universe badge. The very
    // first run for a guild on a device records "now" so an existing guild never opens with a dot for
    // old history. While the Fireside is on screen it counts as seen.
    useEffect(() => {
        if (!firesideId) { setSeenAt(0); return; }
        if (viewingFireside) {
            writeSeen(firesideId, Date.now());
            setSeenAt(Date.now());
            return () => writeSeen(firesideId, Date.now());
        }
        let seen = readSeen(firesideId);
        if (!seen) { seen = Date.now(); writeSeen(firesideId, seen); }
        setSeenAt(seen);
    }, [firesideId, viewingFireside]);

    // The Guild tab's badge: while the Guild tab is closed, poll a cheap head-only count of Fireside posts
    // from other people newer than the last-seen time (same cadence and rules as useUniverseNewCount). While
    // the tab is open it reports 0 - the Fireside dot takes over. Needs a signed-in reader; a failed poll
    // keeps the last count and never turns into an error.
    useEffect(() => {
        if (onGuildTab || !inGuild || !firesideId || !myId) { setTabBadge(0); return; }
        let alive = true;
        let inflight = false;
        const check = async () => {
            if (document.hidden || inflight) return;
            let seen = readSeen(firesideId);
            if (!seen) { seen = Date.now(); writeSeen(firesideId, seen); }
            inflight = true;
            try {
                const { count, error } = await supabase.from('fireside_posts').select('id', { count: 'exact', head: true })
                    .eq('guild_id', firesideId).gt('created_at', new Date(seen).toISOString()).neq('author_id', myId);
                if (alive && !error && typeof count === 'number') setTabBadge(count);
            } catch (e) { /* keep the last count */ }
            finally { inflight = false; }
        };
        check();
        const id = setInterval(check, BADGE_POLL_MS);
        const onVisible = () => { if (!document.hidden) check(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
    }, [onGuildTab, inGuild, firesideId, myId]);

    const newPostCount = (posts && !viewingFireside && seenAt)
        ? posts.filter((p) => new Date(p.created_at).getTime() > seenAt && p.author_id !== myId).length
        : 0;
    const newNotices = (notices && !viewingFireside && seenAt)
        ? notices.filter((n) => new Date(n.created_at).getTime() > seenAt && n.author_id !== myId)
        : [];

    return {
        memberCount, events, anthologies, posts, notices, bookIds,
        firesideTotal: posts ? posts.length : null, newPostCount, newNotices, tabBadge,
    };
}
