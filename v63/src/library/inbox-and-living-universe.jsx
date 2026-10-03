import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { storage } from '../lib/storage.js';
import { GrandLibraryAtmosphere } from './grand-library-cards.jsx';
import { Field } from '../shared-ui/form-fields.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { INBOX_KEY } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchNotifications, subscribeNotificationsRealtime } from '../lib/notifications.js';
import { fetchLivingUniverseFeed } from '../lib/living-universe-feed.js';
import { fetchRecentEventAnnouncements } from '../lib/platform-posts.js';


// One consistent engraved tone for every Inbox glyph below — a muted antique-gold/ivory, held
// fixed across all eight categories regardless of each one's own wax-seal accent color, so the
// icons themselves read as one matched set (only the wax and border color vary by category, the
// same way real letter-seals share one wax color scheme but the stamped mark itself doesn't
// change). Slightly dimmer for the read/outline state, same as the outline circle's own opacity.
export const INBOX_ICON_COLOR = '#F3E7C6';
export const INBOX_ICON_COLOR_MUTED = 'rgba(243,231,198,0.7)';


// ---------- Author Inbox — "The Correspondence Hall" ----------
// The writer's communication hub: reviews, reader letters, reputation notices, sales ledgers,
// guild post, marketplace trade, honor medals, and town-crier notices, gathered as one hall of
// mail — rendered inside GrandLibraryAtmosphere so it reads as the same Hall as Home and the
// Grand Library rather than a bolted-on screen. Unread letters render sealed in wax (a color +
// emblem per category, see INBOX_CATEGORIES); opening one plays a quick seal-crack (ai-seal-crack)
// before the letter unfolds and is marked read. Starred/archived/unread state persists via
// `storage` under INBOX_KEY, the same on-device pattern as the Writer Profile and Guild.
// `icon` is an InkIcon glyph name (see src/shell/ink-icon.jsx), not an emoji — rendered through
// INBOX_ICON_COLOR above wherever a category emblem shows up (the wax seal, the outline circle,
// the category filter pill).
export const INBOX_CATEGORIES = [
    { id: 'reviews', label: 'Reviews', icon: 'star', accent: { light: '#F0D68C', mid: '#C89B3C', deep: '#5C4517' },
        empty: "No reviews have arrived yet \u2014 when readers finish your chronicles, their words will be filed here." },
    { id: 'messages', label: 'Reader Messages', icon: 'sealedLetter', accent: { light: '#E29B9B', mid: '#A24747', deep: '#3D1919' },
        empty: "Your desk is clear \u2014 no letters from readers waiting." },
    { id: 'reputation', label: 'Reputation', icon: 'hourglass', accent: { light: '#C7A3DE', mid: '#8A5AA8', deep: '#2E1A3A' },
        empty: "No reputation notices yet \u2014 your standing in the guild will be chronicled here as it grows." },
    { id: 'sales', label: 'Sales', icon: 'coin', accent: { light: '#9FCBAE', mid: '#4E8064', deep: '#17291F' },
        empty: "No sales recorded yet \u2014 every purchase of your work will be entered in this ledger." },
    { id: 'guild', label: 'Guild Notifications', icon: 'columns', accent: { light: '#A9C0E0', mid: '#4A6690', deep: '#182437' },
        empty: "Nothing from the Guild Hall right now \u2014 invitations, anthology news, and mentions will post here." },
    { id: 'marketplace', label: 'Marketplace Sales', icon: 'tag', accent: { light: '#E3B279', mid: '#B5793A', deep: '#3E2611' },
        empty: "No trade yet \u2014 packs and templates you sell to fellow authors will be recorded here." },
    { id: 'achievements', label: 'Achievement Rewards', icon: 'medal', accent: { light: '#F5DE9C', mid: '#D8A93F', deep: '#4A3610' },
        empty: "No honors claimed yet \u2014 medals earned along the road will be presented here." },
    { id: 'system', label: 'System Announcements', icon: 'horn', accent: { light: '#C9C9D1', mid: '#7A7A85', deep: '#232327' },
        empty: "Quiet for now \u2014 word from the Scriptorium will be posted here when there's news." },
];


export const INBOX_CATEGORY_BY_ID = Object.fromEntries(INBOX_CATEGORIES.map((c) => [c.id, c]));


export function inboxWax(accent) {
    return `radial-gradient(circle at 34% 30%, ${accent.light}, ${accent.mid} 58%, ${accent.deep} 100%)`;
}


export function InboxStars({ rating }) {
    return React.createElement("span", { style: { display: 'inline-flex', gap: 1, verticalAlign: 'middle' } },
        [1, 2, 3, 4, 5].map((n) => React.createElement(InkIcon, {
            key: n, name: n <= rating ? 'starFilled' : 'star', size: 12.5,
            color: n <= rating ? '#E8C468' : 'rgba(154,154,162,0.35)',
        })));
}


export function InboxPill({ children, active, onClick, count }) {
    return React.createElement("button", {
        onClick, style: {
            fontSize: TYPE_SCALE[12], fontWeight: 600, letterSpacing: '0.02em',
            color: active ? '#1A1610' : '#9A9AA2',
            background: active ? '#E8C468' : 'rgba(255,255,255,0.04)',
            border: `1px solid ${active ? '#E8C468' : 'rgba(232,196,104,0.14)'}`,
            borderRadius: RADIUS_SCALE[999], padding: '6px 13px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
            transition: 'all var(--ink-dur) var(--ink-ease)',
        },
    },
        children,
        count > 0 && React.createElement("span", { style: {
                fontSize: TYPE_SCALE[10.5], fontWeight: 700, background: active ? 'rgba(26,22,16,0.25)' : 'rgba(232,196,104,0.16)',
                color: active ? '#1A1610' : '#E8C468', borderRadius: RADIUS_SCALE[999], padding: '1px 6px',
            } }, count));
}


export function InboxItemHeader({ item, cat }) {
    switch (item.category) {
        case 'reviews':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.bookTitle),
                React.createElement("div", { style: { marginTop: 4, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                    React.createElement(InboxStars, { rating: item.rating }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#9A9AA2' } }, `\u00B7 ${item.reviewerName}`)));
        case 'messages':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.subject),
                React.createElement("div", { style: { marginTop: 4, fontSize: TYPE_SCALE[12], color: '#9A9AA2' } }, `from ${item.senderName}`));
        case 'reputation':
            // item.amount is undefined for a real new_follower notification (migration 83, item
            // 18) — those have no reputation-point value the way the seeded milestone letters
            // below do, so that line is skipped rather than printing "+undefined Reputation".
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.title),
                item.amount != null && React.createElement("div", { style: { marginTop: 4, fontSize: TYPE_SCALE[12.5], fontWeight: 700, color: cat.accent.light } }, `+${item.amount} Reputation`));
        case 'sales':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.itemTitle),
                React.createElement("div", { style: { marginTop: 4, fontSize: TYPE_SCALE[12], color: '#9A9AA2', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], flexWrap: 'wrap' } },
                    `${item.itemType} \u00B7 ${item.copies} sold \u00B7 `,
                    React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: cat.accent.light, fontWeight: 700 } },
                        React.createElement(InkIcon, { name: "coin", size: 11.5 }), `${item.earnings} earned`)));
        case 'guild':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: cat.accent.light, marginBottom: 3 } }, item.kind),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.title));
        case 'marketplace':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.itemTitle),
                React.createElement("div", { style: { marginTop: 4, fontSize: TYPE_SCALE[12], color: '#9A9AA2', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], flexWrap: 'wrap' } },
                    `${item.buyerCount} author${item.buyerCount === 1 ? '' : 's'} purchased \u00B7 `,
                    React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 3, color: cat.accent.light, fontWeight: 700 } },
                        React.createElement(InkIcon, { name: "coin", size: 11.5 }), `${item.earnings} earned`)));
        case 'achievements':
            return React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.title),
                React.createElement("div", { style: { marginTop: 4, fontSize: TYPE_SCALE[12.5], fontWeight: 700, color: cat.accent.light } }, item.reward));
        case 'system':
            return React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, item.title);
        default:
            return null;
    }
}


export function inboxActionBtnStyle(active) {
    return {
        fontSize: TYPE_SCALE[12], fontWeight: 600, color: active ? '#1A1610' : '#EFE7D2',
        background: active ? '#E8C468' : 'rgba(255,255,255,0.05)',
        border: `1px solid ${active ? '#E8C468' : 'rgba(255,255,255,0.14)'}`,
        borderRadius: RADIUS_SCALE[7], padding: '6px 12px', cursor: 'pointer',
    };
}


export function InboxLetterCard({ item, cat, index, expanded, cracking, onOpen, onToggleStar, onArchive, onUnarchive }) {
    return React.createElement("div", {
        className: "ai-card-in",
        style: {
            animationDelay: `${Math.min(index, 8) * 45}ms`, position: 'relative',
            background: item.unread ? 'linear-gradient(160deg, #221E15, #1C1912)' : 'linear-gradient(160deg, rgba(28,25,18,0.55), rgba(20,17,13,0.55))',
            border: `1px solid ${item.unread ? 'rgba(232,196,104,0.22)' : 'rgba(232,196,104,0.14)'}`,
            borderLeft: `3px solid ${cat.accent.mid}`, borderRadius: RADIUS_SCALE[10], padding: '16px 18px', marginBottom: 12, cursor: 'pointer',
            boxShadow: item.unread ? '0 6px 18px rgba(0,0,0,0.35)' : '0 2px 8px rgba(0,0,0,0.2)',
            transition: 'border-color 240ms ease, background 240ms ease',
        },
        onClick: () => onOpen(item),
    },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[12] } },
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[12], alignItems: 'flex-start', flex: 1, minWidth: 0 } },
                React.createElement("div", { style: { position: 'relative', width: 30, height: 30, flexShrink: 0, marginTop: 2 } },
                    item.unread
                        ? React.createElement("div", {
                            className: cracking ? 'ai-seal-crack' : 'ai-seal-breathe',
                            style: {
                                width: 26, height: 26, borderRadius: '50%', background: inboxWax(cat.accent),
                                boxShadow: '0 0 0 1px rgba(0,0,0,0.35), 0 2px 5px rgba(0,0,0,0.4)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            },
                        }, React.createElement(InkIcon, {
                            name: cat.icon, size: 13, color: INBOX_ICON_COLOR,
                            style: { filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.4))' },
                        }))
                        : React.createElement("div", {
                            style: {
                                width: 26, height: 26, borderRadius: '50%', border: `1px solid ${cat.accent.mid}`, opacity: 0.55,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                            },
                        }, React.createElement(InkIcon, { name: cat.icon, size: 13, color: INBOX_ICON_COLOR_MUTED }))),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement(InboxItemHeader, { item, cat }),
                    !expanded && React.createElement("div", {
                        style: {
                            marginTop: 6, fontSize: TYPE_SCALE[12.5], color: '#9A9AA2', lineHeight: 1.5,
                            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                        },
                    }, item.body))),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexShrink: 0 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#6B6B72', whiteSpace: 'nowrap' } }, item.time),
                React.createElement("button", {
                    onClick: (e) => { e.stopPropagation(); onToggleStar(item); },
                    title: item.starred ? 'Unstar' : 'Star',
                    style: { background: 'none', border: 'none', cursor: 'pointer', padding: 2, lineHeight: 1, display: 'flex' },
                }, React.createElement(InkIcon, { name: item.starred ? 'starFilled' : 'star', size: 16, color: item.starred ? '#E8C468' : 'rgba(154,154,162,0.45)' })))),
        expanded && React.createElement("div", { className: "ai-unfold", style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid rgba(232,196,104,0.14)' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#EFE7D2', lineHeight: 1.65, whiteSpace: item.category === 'system' ? 'pre-wrap' : undefined } }, item.body),
            React.createElement("div", { style: { marginTop: 14, display: 'flex', gap: SPACE_SCALE[8] } },
                React.createElement("button", {
                    onClick: (e) => { e.stopPropagation(); onToggleStar(item); },
                    style: Object.assign({ display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] }, inboxActionBtnStyle(item.starred)),
                }, React.createElement(InkIcon, { name: item.starred ? 'starFilled' : 'star', size: 12.5 }), item.starred ? 'Starred' : 'Star'),
                item.archived
                    ? React.createElement("button", {
                        onClick: (e) => { e.stopPropagation(); onUnarchive(item); },
                        style: Object.assign({ display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] }, inboxActionBtnStyle(false)),
                    }, React.createElement(InkIcon, { name: "restore", size: 12.5 }), "Restore")
                    : React.createElement("button", {
                        onClick: (e) => { e.stopPropagation(); onArchive(item); },
                        style: Object.assign({ display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] }, inboxActionBtnStyle(false)),
                    }, React.createElement(InkIcon, { name: "archiveBox", size: 12.5 }), "Archive"))));
}


// ---------- Real mail (migration 83, fix-tracker item 18) ----------
// Layers real, server-sourced notifications — new follower, new review, and Guild Order
// activity (a Council proposal, a Manuscript chapter or passage, a World Bible entry, or a
// settled guild event payout) — on top of the local/seeded items above. Everything else the
// Inbox shows (Messages, Sales, Marketplace, Achievements, System, and the non-event-driven
// half of Guild Notifications like invitations/mentions) has no real backend yet and is
// untouched by any of this.

// Which Inbox tab each real notification type belongs in.
const REAL_NOTIFICATION_CATEGORY = {
    new_follower: 'reputation',
    new_review: 'reviews',
    guild_order_proposal_opened: 'guild',
    guild_order_chapter_added: 'guild',
    guild_order_passage_added: 'guild',
    guild_order_world_entry_added: 'guild',
    guild_event_result_posted: 'guild',
    payout_account_changed: 'system',
};

function realNotificationBody(n) {
    switch (n.type) {
        case 'new_follower':
            return `${n.actorName} started following you.`;
        case 'new_review':
            return `${n.actorName} left a ${n.payload.rating}-star review on ${n.bookTitle}.`;
        case 'guild_order_proposal_opened':
            return `${n.actorName} opened a Council proposal: \u201C${n.payload.title}\u201D`;
        case 'guild_order_chapter_added':
            return `${n.actorName} proposed a new Manuscript chapter: \u201C${n.payload.title}\u201D`;
        case 'guild_order_passage_added':
            return `${n.actorName} added a passage to \u201C${n.payload.chapter_title}\u201D.`;
        case 'guild_order_world_entry_added':
            return `${n.actorName} added a World Bible entry: \u201C${n.payload.title}\u201D${n.payload.category ? ` (${n.payload.category})` : ''}`;
        case 'guild_event_result_posted': {
            const pct = typeof n.payload.share_bps === 'number' ? (n.payload.share_bps / 100).toFixed(1) : null;
            return `Your guild event results were posted${n.payload.place ? ` \u2014 you placed #${n.payload.place}` : ''}${pct ? `, a ${pct}% share` : ''}.`;
        }
        case 'payout_account_changed': {
            // Migration 111: fired by a trigger on bank_accounts whenever a payout account is
            // added or the default changes. Only the last four digits ever reach the client.
            const acct = `${n.payload.bank_name || 'A bank account'} \u2022\u2022\u2022\u2022 ${n.payload.last4 || ''}`.trim();
            const head = n.payload.change === 'default_changed'
                ? `Your default payout account was changed to ${acct}.`
                : `A payout account (${acct}) was added to your Inkroot account${n.payload.is_default ? ' and set as your default' : ''}.`;
            const lock = n.payload.cooldown_applies
                ? ` For your security, withdrawals to it unlock after ${n.payload.cooldown_hours || 24} hours.`
                : '';
            return `${head}${lock} If this wasn't you, secure your account and contact Inkroot right away.`;
        }
        default:
            return '';
    }
}

function mapNotificationToInboxItem(n) {
    const category = REAL_NOTIFICATION_CATEGORY[n.type];
    if (!category)
        return null;
    const item = {
        id: `ntf-${n.id}`, category, unread: true, starred: false, archived: false,
        time: luTimeAgo(new Date(n.createdAt).getTime()), body: realNotificationBody(n),
    };
    if (n.type === 'new_review') {
        item.bookTitle = n.bookTitle;
        item.rating = n.payload.rating;
        item.reviewerName = n.actorName;
    }
    else if (n.type === 'new_follower') {
        item.title = 'New Follower';
    }
    else if (n.type === 'payout_account_changed') {
        item.title = n.payload.change === 'default_changed' ? 'Default payout account changed' : 'Payout account added';
    }
    else {
        item.kind = n.type === 'guild_event_result_posted' ? 'Event Payout'
            : n.type === 'guild_order_proposal_opened' ? 'Council Proposal'
                : n.type === 'guild_order_world_entry_added' ? 'World Bible'
                    : 'Manuscript';
        item.title = n.payload.title || n.payload.chapter_title || 'Guild Order update';
    }
    return item;
}

// existing/real: real mail always leads its category (fetchNotifications already returns
// newest-first) — an id already known locally keeps its own unread/starred/archived state
// rather than getting reset to unread by every refetch; a brand-new one starts unread. (Old
// seed-mail retirement used to be handled here per-category; the one-time cleanup in
// AuthorInboxScreen's load effect now strips every old seed letter unconditionally, so there's
// nothing category-specific left to retire at merge time.)
export function mergeRealNotifications(existing, real) {
    const mappedReal = real.map(mapNotificationToInboxItem).filter(Boolean);
    const merged = mappedReal.map((m) => existing.find((i) => i.id === m.id) || m);
    const mergedIds = new Set(merged.map((i) => i.id));
    const rest = existing.filter((i) => !mergedIds.has(i.id));
    return [...merged, ...rest];
}


// System Announcements: published Inkroot event announcements (Living Universe Platform Updates of
// type event_announcement) from the last 30 days, read straight from platform_posts - no per-user
// copies. Ids are `plat-<post id>`, so read/starred/archived state is kept per device like all other
// mail. Anything the server no longer returns (hidden, removed, or older than 30 days) is dropped.
// Only called with a successful fetch, so being offline or signed out never prunes anything.
export const SYSTEM_ANNOUNCEMENT_DAYS = 30;
export function mergeEventAnnouncements(existing, posts) {
    const mapped = posts.map((p) => {
        const old = existing.find((i) => i.id === `plat-${p.id}`);
        return {
            id: `plat-${p.id}`, category: 'system', title: p.title, body: p.body,
            time: luTimeAgo(new Date(p.created_at).getTime()),
            unread: old ? old.unread : true, starred: old ? old.starred : false, archived: old ? old.archived : false,
        };
    });
    return [...existing.filter((i) => !i.id.startsWith('plat-')), ...mapped];
}

// One-time cleanup only — these are the exact id prefixes the old, now-removed seedInboxItems()
// generator used and nothing else ever has: real mail ids are `ntf-<id>` (mapNotificationToInboxItem
// below) and real Chronicle-feed ids are `feed-<id>` (luAdaptRealFeedEntry above), so filtering
// these eight out can never drop a real item, only a fake letter a device saved before simulated
// inbox content was retired. New installs never write these ids in the first place. Exported so
// home-screen.jsx's Inbox-badge tally (which peeks at INBOX_KEY directly, without mounting
// AuthorInboxScreen) can apply the exact same cleanup rather than a second, hand-copied list.
export const OLD_SEED_ID_PREFIXES = ['rev-', 'msg-', 'rep-', 'sale-', 'gld-', 'mkt-', 'ach-', 'sys-'];

// The Author Inbox screen itself — owns its own items (loaded from / saved to storage under
// INBOX_KEY, same pattern as GrandLibraryScreen owning its own reader/author state) so HomeScreen
// doesn't need to thread mail state through props. HomeScreen still peeks at INBOX_KEY separately
// for the unread badge on the nav tab (see its inboxUnreadCount effect) since this component only
// mounts while the Inbox tab is actually open.
export function AuthorInboxScreen() {
    const [items, setItems] = useState(null); // null while loading
    const [activeCat, setActiveCat] = useState('reviews');
    const [filter, setFilter] = useState('all'); // all | unread | starred | archived
    const [query, setQuery] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [crackingId, setCrackingId] = useState(null);
    const crackTimeout = useRef(null);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let base = null;
            const res = await storage.get(INBOX_KEY);
            if (cancelled)
                return;
            if (res) {
                try {
                    base = JSON.parse(res.value);
                }
                catch (e) { /* fall through to the empty default below */ }
            }
            if (base === null) {
                // No simulated inbox content of any kind (V1 rule: anything that looks like real
                // user activity must come from real data) — an inbox with nothing real yet starts
                // empty and shows each category's own empty-state (see INBOX_CATEGORIES) until
                // real backend activity exists.
                base = [];
            }
            // One-time cleanup: strip any old seed letters a device saved before simulated inbox
            // content was removed (see OLD_SEED_ID_PREFIXES above) — a no-op for a device that
            // never had any or already had them cleaned. The persistence effect below (storage.set
            // on `items` change) writes the cleaned list straight back, so this only ever runs once
            // per device.
            base = base.filter((i) => !OLD_SEED_ID_PREFIXES.some((p) => i.id.startsWith(p)));
            setItems(base);
            // Layer real mail (migration 83, fix-tracker item 18) on top — best-effort: a
            // signed-out writer, or an offline device, just keeps whatever local mail it already
            // had, same fallback posture every other real-data layer in this app takes.
            try {
                const real = await fetchNotifications();
                if (!cancelled && real.length > 0)
                    setItems((prev) => mergeRealNotifications(prev || base, real));
            }
            catch (e) { /* no real mail available right now — local mail stands */ }
            // System Announcements: recent event announcements (see mergeEventAnnouncements above).
            try {
                const posts = await fetchRecentEventAnnouncements(SYSTEM_ANNOUNCEMENT_DAYS);
                if (!cancelled && posts)
                    setItems((prev) => mergeEventAnnouncements(prev || base, posts));
            }
            catch (e) { /* announcements unavailable right now — whatever is saved locally stands */ }
        })();
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        let unsubscribe = () => { };
        (async () => {
            const user = await currentUser();
            if (!user)
                return;
            unsubscribe = subscribeNotificationsRealtime(user.id, async () => {
                try {
                    const real = await fetchNotifications();
                    setItems((prev) => (prev === null ? prev : mergeRealNotifications(prev, real)));
                }
                catch (e) { /* best-effort, same as the initial fetch above */ }
            });
        })();
        return () => unsubscribe();
    }, []);
    useEffect(() => {
        if (items === null)
            return;
        storage.set(INBOX_KEY, JSON.stringify(items)).catch(() => { });
    }, [items]);
    useEffect(() => () => clearTimeout(crackTimeout.current), []);
    const cat = INBOX_CATEGORY_BY_ID[activeCat];
    const tabItems = useMemo(() => (items || []).filter((i) => i.category === activeCat), [items, activeCat]);
    const unreadCounts = useMemo(() => {
        const m = {};
        INBOX_CATEGORIES.forEach((c) => { m[c.id] = (items || []).filter((i) => i.category === c.id && i.unread && !i.archived).length; });
        return m;
    }, [items]);
    const filtered = useMemo(() => {
        let list = tabItems;
        if (filter === 'archived')
            list = list.filter((i) => i.archived);
        else {
            list = list.filter((i) => !i.archived);
            if (filter === 'unread')
                list = list.filter((i) => i.unread);
            if (filter === 'starred')
                list = list.filter((i) => i.starred);
        }
        if (query.trim()) {
            const q = query.trim().toLowerCase();
            list = list.filter((i) => JSON.stringify(i).toLowerCase().includes(q));
        }
        return list;
    }, [tabItems, filter, query]);
    const filterCounts = useMemo(() => {
        const base = tabItems.filter((i) => !i.archived);
        return {
            unread: base.filter((i) => i.unread).length,
            starred: base.filter((i) => i.starred).length,
            archived: tabItems.filter((i) => i.archived).length,
        };
    }, [tabItems]);
    function selectCat(id) {
        setActiveCat(id);
        setExpandedId(null);
        setQuery('');
        setFilter('all');
    }
    function openItem(item) {
        if (expandedId === item.id) {
            setExpandedId(null);
            return;
        }
        if (item.unread) {
            setCrackingId(item.id);
            crackTimeout.current = setTimeout(() => {
                setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, unread: false } : i)));
                setCrackingId(null);
                setExpandedId(item.id);
            }, 420);
        }
        else {
            setExpandedId(item.id);
        }
    }
    function toggleStar(item) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, starred: !i.starred } : i)));
    }
    function archiveItem(item) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, archived: true } : i)));
        setExpandedId(null);
    }
    function unarchiveItem(item) {
        setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, archived: false } : i)));
    }
    function markAllRead() {
        setItems((prev) => prev.map((i) => (i.category === activeCat ? { ...i, unread: false } : i)));
    }
    if (items === null) {
        return React.createElement(GrandLibraryAtmosphere, null,
            React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#948D7E' } }, "Sorting the morning post\u2026"));
    }
    const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
    return React.createElement(GrandLibraryAtmosphere, null,
        React.createElement("div", { style: { marginBottom: 22 } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Correspondence Hall"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: totalUnread > 0 ? '#C89B3C' : '#8A8A92', marginTop: 4 } },
                totalUnread > 0 ? `${totalUnread} unopened letter${totalUnread === 1 ? '' : 's'} across the Hall` : "You're caught up on every letter in the Hall.")),
        React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[6], marginBottom: 18 } },
            INBOX_CATEGORIES.map((c) => {
                const active = c.id === activeCat;
                const count = unreadCounts[c.id];
                return React.createElement("button", {
                    key: c.id, onClick: () => selectCat(c.id),
                    style: {
                        display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], padding: '8px 12px', borderRadius: RADIUS_SCALE[9], cursor: 'pointer',
                        background: active ? 'rgba(232,196,104,0.12)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${active ? 'rgba(232,196,104,0.32)' : 'rgba(232,196,104,0.14)'}`,
                        fontSize: TYPE_SCALE[12.5], fontWeight: active ? 700 : 500, color: active ? '#EFE7D2' : '#9A9AA2',
                        transition: 'background 200ms ease',
                    },
                },
                    React.createElement(InkIcon, { name: c.icon, size: 13.5, color: active ? INBOX_ICON_COLOR : INBOX_ICON_COLOR_MUTED, style: { display: 'inline-block' } }),
                    React.createElement("span", null, c.label),
                    count > 0 && React.createElement("span", {
                        style: {
                            fontSize: TYPE_SCALE[10], fontWeight: 700, color: '#1A1610', background: '#E8C468', borderRadius: RADIUS_SCALE[999],
                            minWidth: 16, textAlign: 'center', padding: '1px 5px', lineHeight: '14px',
                        },
                    }, count));
            })),
        React.createElement("div", { style: { background: 'rgba(20,17,13,0.6)', border: '1px solid rgba(232,196,104,0.14)', borderRadius: RADIUS_SCALE[10], padding: '12px 14px', marginBottom: 16 } },
            React.createElement("div", { style: { position: 'relative', marginBottom: 10 } },
                React.createElement("span", { style: { position: 'absolute', left: 12, top: '50%', transform: 'translate(0, -50%)', opacity: 0.6, display: 'flex' } },
                    React.createElement(InkIcon, { name: "search", size: 13, color: INBOX_ICON_COLOR })),
                React.createElement("input", {
                    value: query, onChange: (e) => setQuery(e.target.value),
                    placeholder: `Search ${cat.label.toLowerCase()}\u2026`,
                    style: {
                        width: '100%', background: 'rgba(0,0,0,0.25)', border: '1px solid rgba(232,196,104,0.14)',
                        borderRadius: RADIUS_SCALE[7], padding: '9px 12px 9px 32px', color: '#EFE7D2', fontSize: TYPE_SCALE[13],
                    },
                })),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: SPACE_SCALE[8] } },
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                    React.createElement(InboxPill, { active: filter === 'all', onClick: () => setFilter('all'), count: 0 }, "All"),
                    React.createElement(InboxPill, { active: filter === 'unread', onClick: () => setFilter('unread'), count: filterCounts.unread }, "Unread"),
                    React.createElement(InboxPill, { active: filter === 'starred', onClick: () => setFilter('starred'), count: filterCounts.starred }, "Starred"),
                    React.createElement(InboxPill, { active: filter === 'archived', onClick: () => setFilter('archived'), count: filterCounts.archived }, "Archived")),
                filterCounts.unread > 0 && filter !== 'archived' && React.createElement("button", {
                    onClick: markAllRead,
                    style: { background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12], cursor: 'pointer', fontWeight: 600 },
                }, "Mark all read"))),
        filtered.length === 0
            ? React.createElement("div", {
                style: { textAlign: 'center', padding: '48px 20px', color: '#948D7E', fontSize: TYPE_SCALE[13.5], border: '1px dashed rgba(232,196,104,0.14)', borderRadius: RADIUS_SCALE[10], fontStyle: 'italic' },
            }, query.trim()
                ? "No correspondence matches your search."
                : filter === 'archived' ? "Nothing archived yet \u2014 letters you tuck away will rest here."
                    : filter === 'starred' ? "No starred items in this tab yet."
                        : filter === 'unread' ? "Nothing unread here \u2014 you're all caught up."
                            : cat.empty)
            : filtered.map((item, idx) => React.createElement(InboxLetterCard, {
                key: item.id, item, cat, index: idx,
                expanded: expandedId === item.id, cracking: crackingId === item.id,
                onOpen: openItem, onToggleStar: toggleStar, onArchive: archiveItem, onUnarchive: unarchiveItem,
            })));
}


// ---------- The Living Universe ----------
// A public chronicle of what is really happening across Inkroot. Every entry on this screen
// comes from the server (migration 84's list_living_universe_feed, plus the ranking RPCs the
// screen calls itself) - nothing is invented on the device any more.
//
// History: this screen used to generate its own atmosphere client-side (made-up authors, made-up
// books, a new fake entry every 16-30 seconds, fake Guild Events), stored under
// LU_LEGACY_STORAGE_KEYS. That made the Universe look busy but feel dead the moment anyone
// looked closely, so it was removed. An honest, quiet screen with a clear next step beats a
// fake-populated one. useLivingUniverseFeed() below also deletes those old keys once per
// device, so a phone that saved the old simulation stops showing it.
//
// Kinds the real feed can carry today: 'release', 'follow', 'review', 'guild'. Rank ascensions,
// reputation milestones, achievement unlocks, anthologies and world packs have no public source
// yet, so they are simply not shown until one exists.
//
// `seal` MUST stay a plain string icon key, never an InkIcon element - see luIconKey() below.
export function luIconKey(value) {
    if (typeof value === 'string') return value;
    // An InkIcon element (React.createElement(InkIcon, { name, ... })) — .props is the same
    // plain, public object it's always been, Symbol-free, so reading .props.name back out here
    // is safe and gives back exactly the icon key InkIcon was built from.
    if (value && typeof value === 'object' && value.props && typeof value.props.name === 'string') return value.props.name;
    return null;
}


// The two device-storage keys the old simulation wrote to. Only ever read to be deleted.
const LU_LEGACY_STORAGE_KEYS = ['inkroot:livingUniverseFeed', 'inkroot:guildEvents'];


// Not shown on the Living Universe any more. Guild Order (guild/guild-order.jsx) still imports
// this list for its own purposes, so it stays exported until that file is looked at separately.
export const LU_AUTHORS = ['Elara Voss', 'Kael Thorne', 'Wren Ashbury', 'Marlowe Finch', 'Isolde Graye', 'Thane Ashford',
    'Briony Vale', 'Corin Blackwood', 'Seraphine Wilde', 'Dorian Marsh', 'Lyra Fenwick', 'Adric Stone',
    'Hollis Bramwell', 'Wynne Castellan', 'Osric Falk', 'Maren Loch', 'Tamsin Ridley', 'Callum Drake',
    'Ines Solari', 'Percival Rook', 'Sable Quinn', 'Rowan Ashcombe'];


export const LU_GENRE_COLOR = { fantasy: '#B08D57', romance: '#C97B8B', scifi: '#7FB2C9', historical: '#A8916A',
    horror: '#8C7A93', mystery: '#7A8FA3', comedy: '#D4A63A', worldbuilders: '#A184D6', poetry: '#8FA37A', general: '#C7CCD6' };


// Guild event phase from its dates. Real events use their own approval status instead (see
// LU_GE_STATUS_PHASE in living-universe-screen.jsx); this is only the time-based fallback.
export function luGuildEventPhase(ev, now) {
    if (now < ev.startAt) return 'upcoming';
    if (now > ev.endAt) return 'completed';
    return 'active';
}


export function luTimeAgo(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24); if (d < 7) return `${d}d ago`;
    return `${Math.floor(d / 7)}w ago`;
}


// Some accounts carry an auto-generated display name such as "Writer 407c821d" (a hex id fragment).
// Showing that in a public feed reads like a bug, so it is swapped for a plain word.
const LU_AUTO_NAME = /^(writer|reader|user)\s+[0-9a-f]{6,}$/i;
export function luFriendlyName(name, fallback = 'A writer') {
    const n = (name || '').trim();
    if (!n || LU_AUTO_NAME.test(n)) return fallback;
    return n;
}


// Maps one real feed row (see fetchLivingUniverseFeed) onto the Chronicle entry shape the screen
// renders ({ id, ts, seal, color, title, sub, tag, kind, ... }). The ids (bookId, guildId) are
// carried through so a card can open the thing it is about.
export function luAdaptRealFeedEntry(row) {
    const p = row.payload || {};
    const ts = new Date(row.createdAt).getTime();
    const base = { id: `feed-${row.id}`, ts, kind: row.kind };
    switch (row.kind) {
        case 'release': {
            const author = luFriendlyName(p.author_name);
            return { ...base, seal: 'book', color: LU_GENRE_COLOR[p.genre] || '#B08D57',
                title: `${author} published \u201C${p.title}\u201D`, sub: 'New Release', tag: 'New Release',
                book: p.title, bookId: p.book_id, author, genre: p.genre };
        }
        case 'follow': {
            const who = luFriendlyName(p.follower_name);
            const whom = luFriendlyName(p.followee_name, 'a writer');
            return { ...base, seal: 'candle', color: '#7FB2C9',
                title: `${who} started following ${whom}`, sub: 'New Follower', tag: 'Follower', follower: who, followee: whom };
        }
        case 'review': {
            const who = luFriendlyName(p.reviewer_name, 'A reader');
            return { ...base, seal: 'candle', color: '#8FA37A',
                title: `${who} reviewed \u201C${p.title}\u201D (${p.rating}\u2605)`, sub: 'Reader Review', tag: 'Review',
                book: p.title, bookId: p.book_id, rating: p.rating };
        }
        case 'guild': {
            const who = luFriendlyName(p.user_name);
            return { ...base, seal: 'castle', color: '#C89B3C',
                title: `${who} joined ${p.guild_name}`, sub: 'Guild Hall', tag: 'Guild Hall',
                guildId: p.guild_id, guildName: p.guild_name };
        }
        default:
            return null;
    }
}


// Real feed only. Returns { entries, failed }:
//   entries = null while the first fetch is in flight, otherwise a newest-first array
//             (empty when nothing has happened yet, or when the fetch failed);
//   failed  = true when the fetch itself errored, so the screen can say "couldn't reach the
//             Chronicle" instead of pretending nothing has happened.
// One pull-on-open fetch, same posture as the other real sections on the screen.
// How often the Chronicle quietly re-checks for new happenings while the tab is visible. Polling
// (not a realtime subscription) on purpose: it needs no backend or publication change, and the feed
// RPC is already public and cheap. Paused while the tab is hidden; one catch-up fetch on return.
const LU_POLL_MS = 45000;
const LU_MAX_KEPT = 200;

// Re-renders the caller every `ms` so relative times ("3m ago") keep counting while the page is open.
export function useNowTick(ms = 15000) {
    const [, setN] = useState(0);
    useEffect(() => {
        const bump = () => { if (!document.hidden) setN((n) => n + 1); };
        const id = setInterval(bump, ms);
        document.addEventListener('visibilitychange', bump);
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', bump); };
    }, [ms]);
}

// "just now" / "12s ago" / falls back to luTimeAgo - for the small "Live" status line only.
export function luUpdatedAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 10) return 'just now';
    if (s < 60) return `${s}s ago`;
    return luTimeAgo(ts);
}

// The Chronicle feed. Same { entries, failed } contract as before (entries === null while the first
// load is in flight), plus live behaviour:
//   - re-fetches every LU_POLL_MS while visible; a failed poll never wipes what is on screen
//   - newer happenings are NOT spliced in under the reader's thumb: they wait in `pending` and
//     `showPending()` prepends them (the screen renders this as a "N new" pill)
//   - `freshIds` marks just-revealed entries for a one-off entrance animation
//   - `updatedAt` / `stale` / `refreshing` / `refresh()` drive the small "Live" status line
export function useLivingUniverseFeed() {
    const [state, setState] = useState({ entries: null, failed: false });
    const [pending, setPending] = useState([]);
    const [freshIds, setFreshIds] = useState(() => new Set());
    const [meta, setMeta] = useState({ updatedAt: 0, stale: false, refreshing: false });
    const shownRef = useRef(null);
    const pendingRef = useRef([]);
    const inflightRef = useRef(false);
    const lastFetchRef = useRef(0);
    const aliveRef = useRef(true);
    const freshTimerRef = useRef(null);

    const markFresh = useCallback((ids) => {
        setFreshIds(new Set(ids));
        if (freshTimerRef.current) clearTimeout(freshTimerRef.current);
        freshTimerRef.current = setTimeout(() => setFreshIds(new Set()), 4000);
    }, []);

    const load = useCallback(async (initial) => {
        if (inflightRef.current) return;
        inflightRef.current = true;
        try {
            const rows = await fetchLivingUniverseFeed({ limit: 60 });
            if (!aliveRef.current) return;
            const fetched = rows.map(luAdaptRealFeedEntry).filter(Boolean).sort((a, b) => b.ts - a.ts);
            lastFetchRef.current = Date.now();
            const shown = shownRef.current;
            // First load, recovery after a failed first load, or a previously empty Chronicle: show directly.
            if (initial || !shown || shown.length === 0) {
                shownRef.current = fetched;
                setState({ entries: fetched, failed: false });
                if (!initial && fetched.length) markFresh(fetched.map((e) => e.id));
            } else {
                const shownIds = new Set(shown.map((e) => e.id));
                const oldestShown = shown[shown.length - 1].ts;
                const incoming = fetched.filter((e) => !shownIds.has(e.id) && e.ts >= oldestShown);
                pendingRef.current = incoming;
                setPending(incoming);
            }
            setMeta((m) => ({ ...m, updatedAt: Date.now(), stale: false }));
        } catch (e) {
            if (!aliveRef.current) return;
            if (initial || !shownRef.current) {
                shownRef.current = [];
                setState({ entries: [], failed: true });
            } else {
                setMeta((m) => ({ ...m, stale: true }));
            }
        } finally {
            inflightRef.current = false;
        }
    }, [markFresh]);

    useEffect(() => {
        aliveRef.current = true;
        (async () => {
            for (const key of LU_LEGACY_STORAGE_KEYS) {
                try { const res = await storage.get(key); if (res) await storage.delete(key); } catch (e) { /* best-effort */ }
            }
        })();
        load(true);
        const poll = () => { if (!document.hidden) load(false); };
        const id = setInterval(poll, LU_POLL_MS);
        const onVisible = () => { if (!document.hidden && Date.now() - lastFetchRef.current > 15000) load(false); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            aliveRef.current = false;
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
            if (freshTimerRef.current) clearTimeout(freshTimerRef.current);
        };
    }, [load]);

    const showPending = useCallback(() => {
        const add = pendingRef.current;
        if (!add.length || !shownRef.current) return;
        const merged = [...add, ...shownRef.current].sort((a, b) => b.ts - a.ts).slice(0, LU_MAX_KEPT);
        shownRef.current = merged;
        pendingRef.current = [];
        setPending([]);
        markFresh(add.map((e) => e.id));
        setState({ entries: merged, failed: false });
    }, [markFresh]);

    const refresh = useCallback(async () => {
        setMeta((m) => ({ ...m, refreshing: true }));
        await load(false);
        if (aliveRef.current) setMeta((m) => ({ ...m, refreshing: false }));
    }, [load]);

    return { entries: state.entries, failed: state.failed, pending, showPending, freshIds, refresh,
        updatedAt: meta.updatedAt, stale: meta.stale, refreshing: meta.refreshing };
}

// The Universe tab's unread badge. LivingUniverseScreen (and its own useLivingUniverseFeed, whose "N new
// happenings" pill counts entries newer than what is on screen) only mounts while the Universe tab is open,
// so the bottom bar cannot read that pill's number directly. This hook keeps the same meaning for the time
// the tab is closed: it counts happenings (same feed RPC, same luAdaptRealFeedEntry adapter) newer than the
// last moment the reader was on the Universe. While the Universe is open it reports 0 and stops polling -
// the screen's own pill takes over. The last-seen time is kept per device (localStorage, best-effort); the
// very first run on a device records "now" so a new install never opens with a badge for old history.
// The feed fetch window is 60 rows, so the count tops out at 60 even if more arrived.
const LU_SEEN_KEY = 'inkroot:universe:seen-at';
export function useUniverseNewCount(onUniverse) {
    const [count, setCount] = useState(0);
    useEffect(() => {
        const readSeen = () => { try { const v = Number(localStorage.getItem(LU_SEEN_KEY)); return v > 0 ? v : 0; } catch (e) { return 0; } };
        const writeSeen = (t) => { try { localStorage.setItem(LU_SEEN_KEY, String(t)); } catch (e) { /* best-effort */ } };
        if (onUniverse) {
            writeSeen(Date.now());
            setCount(0);
            return () => writeSeen(Date.now());
        }
        let seen = readSeen();
        if (!seen) { seen = Date.now(); writeSeen(seen); }
        let alive = true;
        let inflight = false;
        const check = async () => {
            if (document.hidden || inflight) return;
            inflight = true;
            try {
                const rows = await fetchLivingUniverseFeed({ limit: 60 });
                if (!alive) return;
                setCount(rows.map(luAdaptRealFeedEntry).filter(Boolean).filter((e) => e.ts > seen).length);
            } catch (e) { /* keep the last count; the badge never turns into an error */ }
            finally { inflight = false; }
        };
        check();
        const id = setInterval(check, LU_POLL_MS);
        const onVisible = () => { if (!document.hidden) check(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { alive = false; clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
    }, [onUniverse]);
    return count;
}



// One line per section: a short serif label on the left and, only when there is somewhere to go, a quiet
// "See all" on the right. The eyebrow, the poetic title and the subtitle that used to stack above every
// section are gone on purpose - they slowed scanning on a screen that is nine sections long. `icon` is an
// InkIcon glyph name (see src/shell/ink-icon.jsx) shown in front of the label; `count` is an optional
// real number rendered beside it. Explanatory copy now lives in the section's own short caption (see
// LuCharts) or its detail sheet, not in the header.
export function LuSectionHeader({ title, icon, count, actionLabel, onAction, id }) {
    return React.createElement("div", { className: "lu-head" },
        React.createElement("h2", { className: "lu-head-title", id },
            icon && React.createElement("span", { className: "lu-head-icon", "aria-hidden": "true" }, React.createElement(InkIcon, { name: icon, size: 15, color: "currentColor" })),
            title,
            count !== undefined && count !== null && React.createElement("span", { className: "lu-head-count" }, count)),
        actionLabel && onAction && React.createElement("button", { type: "button", className: "lu-head-action", onClick: onAction },
            actionLabel, React.createElement("span", { "aria-hidden": "true" }, " \u203A")));
}
