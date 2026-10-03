import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { FOUNDER_GUILDS } from '../guild/guild-hall.jsx';
import { fetchRisingStars } from '../lib/rising-stars.js';
import { fetchBestSellers, fetchMostRead, fetchTrending } from '../lib/book-rankings.js';
import { fetchGuildsOnRise } from '../lib/guild-rankings.js';
import { fetchPublicGuildEvents } from '../lib/guild-events.js';
import { EVENT_TYPE_LABELS, EventTypeBadge } from '../guild/guild-event-ui.jsx';
import { INBOX_ICON_COLOR, LuSectionHeader, luTimeAgo, luUpdatedAgo, useLivingUniverseFeed, useNowTick } from './inbox-and-living-universe.jsx';
import { PlatformPostsFeed } from './platform-posts-feed.jsx';
import { formatNaira, koboToNaira } from '../lib/payments.js';
import { ICON_PATHS, InkIcon } from '../shell/ink-icon.jsx';
import { TYPE_SCALE } from '../shell/nav-context.jsx';
import { Fold } from '../shared-ui/ui-primitives.jsx';
import './living-universe.css';


// The Universe's gold, named once for the places that need it as a JS value (the CSS uses var(--lu-gold)).
const LU_GOLD = '#E8C468';

// Badge/seal fields on this screen (guild-event covers, feed entries, guild cards) hold an InkIcon glyph
// name. LuGlyph renders a known InkIcon name as a proper engraved glyph in this screen's ivory/gold
// tone; anything else (a shared rank/achievement badge borrowed from elsewhere in the app) renders
// exactly as it always has.
function LuGlyph({ value, size = 14, color = INBOX_ICON_COLOR, style }) {
    if (value && ICON_PATHS[value]) return React.createElement(InkIcon, { name: value, size, color, style });
    return React.createElement("span", { style }, value);
}


const LU_GE_PHASE_META = {
    upcoming: { label: 'Upcoming', color: '#7FB2C9' },
    active: { label: 'Active', color: '#8FA37A' },
    completed: { label: 'Completed', color: '#8F8A80' },
};


function luFormatEventDate(ts) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


function luGuildNameForGenre(genre) {
    const g = FOUNDER_GUILDS.find((x) => x.id === genre);
    return g ? g.name.replace('The ', '').replace(' Guild', '') : 'General';
}


// One event card, shared by the Upcoming / Active / Recently Completed rows below - only its phase (for
// the status pill's color/label) differs between rows. Events come from list_public_guild_events (see
// fetchPublicGuildEvents), so each carries a real guildId/id and opens the guild's public profile or the
// event's own detail page.
// The fourth card cell: when it matters for this row's phase (the row heading already says which phase it is).
function luTimingCell(ev, phase) {
    if (phase === 'active') return { label: 'Closes', value: luEndsIn(ev.endAt).replace('Ends in ', 'in ').replace('Ending now', 'Now') };
    if (phase === 'upcoming') return { label: 'Opens', value: luFormatEventDate(ev.startAt) };
    return { label: 'Ended', value: luFormatEventDate(ev.endAt) };
}

function LuGuildEventCard({ ev, phase, onOpenGuild, onOpenEvent }) {
    const meta = LU_GE_PHASE_META[phase];
    const clickableGuild = !!(onOpenGuild && ev.guildId);
    const clickableEvent = !!(onOpenEvent && ev.real);
    const timing = luTimingCell(ev, phase);
    const openEvent = () => onOpenEvent(ev.id);
    // A tappable card is also a real button for keyboard and screen-reader users (Enter or Space opens it).
    const cardProps = clickableEvent
        ? { role: 'button', tabIndex: 0, className: 'lu-ge-card lu-tap', onClick: openEvent, 'aria-label': `${ev.title}, ${ev.guildName}. ${meta.label}. Open event`,
            onKeyDown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openEvent(); } } }
        : { className: 'lu-ge-card' };
    return React.createElement("div", cardProps,
        React.createElement("div", { className: "lu-ge-cover", style: { background: ev.cover } },
            React.createElement("div", { className: "lu-ge-cover-badge" },
                React.createElement(LuGlyph, { value: ev.icon, size: 15, style: { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' } })),
            ev.real && ev.host === 'inkroot' && React.createElement("div", { className: "lu-ge-official" }, "Official"),
            React.createElement("div", { className: "lu-ge-cover-title" }, ev.title)),
        React.createElement("div", { className: "lu-ge-body" },
            React.createElement("div", {
                    className: "lu-ge-guild", style: clickableGuild ? { cursor: 'pointer' } : undefined,
                    onClick: clickableGuild ? (e) => { e.stopPropagation(); onOpenGuild(ev.guildId); } : undefined,
                    ...(clickableGuild ? { role: 'link', tabIndex: 0, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenGuild(ev.guildId); } } } : null),
                },
                React.createElement("span", { style: { display: 'flex', alignItems: 'center' } }, React.createElement(LuGlyph, { value: ev.guildIcon, size: 12, color: "currentColor" })),
                React.createElement("span", null, ev.guildName)),
            ev.eventType && React.createElement(EventTypeBadge, { eventType: ev.eventType, style: { marginTop: -2, marginBottom: 9 } }),
            React.createElement("div", { className: "lu-ge-stats" },
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, "Entry fee"),
                    React.createElement("div", { className: "lu-ge-stat-value" }, ev.entryFeeNaira ? formatNaira(ev.entryFeeNaira) : 'Free')),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, ev.host === 'inkroot' ? 'Cash prize' : 'Prize pool'),
                    React.createElement("div", { className: "lu-ge-stat-value" }, formatNaira(ev.prizePoolNaira))),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, "Participants"),
                    React.createElement("div", { className: "lu-ge-stat-value" }, ev.participantCount)),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, timing.label),
                    React.createElement("div", { className: "lu-ge-stat-value", style: phase === 'active' ? { color: meta.color } : undefined }, timing.value))),
            // Entry and play live on the event's own page (tapping the card opens it), so a player can enter from here
            // without going through the host guild. Only a real, running event has anything to enter.
            clickableEvent && phase === 'active' && React.createElement("div", { className: "lu-ge-enter" }, "Open to enter \u2192")));
}


function LuGuildEventGroup({ phase, events, emptyText, onOpenGuild, onOpenEvent, hideTitle }) {
    const meta = LU_GE_PHASE_META[phase];
    // Each row shows a page at a time; the "Show more" tile at the end of the shelf reveals the next page.
    const [shown, setShown] = useState(LU_GE_PAGE_SIZE);
    const visible = events.slice(0, shown);
    const remaining = events.length - visible.length;
    return React.createElement("div", { className: "lu-ge-group" },
        !hideTitle && React.createElement("div", { className: "lu-ge-group-title" },
            React.createElement("span", { className: "lu-ge-group-dot", style: { background: meta.color } }),
            `${meta.label} (${events.length})`),
        events.length
            ? React.createElement("div", { className: "lu-ge-shelf" },
                visible.map((ev) => React.createElement(LuGuildEventCard, { key: ev.id, ev, phase, onOpenGuild, onOpenEvent })),
                remaining > 0 && React.createElement("button", { type: "button", className: "lu-ge-more", onClick: () => setShown((n) => n + LU_GE_PAGE_SIZE) },
                    React.createElement("span", null, "Show more"),
                    React.createElement("span", { className: "lu-ge-more-count" }, `${remaining} more`)))
            : React.createElement("div", { className: "lu-ge-empty" }, emptyText));
}


// How many events each Guild Events row shows before its "Show more" tile; each tap reveals this many more.
const LU_GE_PAGE_SIZE = 12;

// Search text for one event: title, host guild and event type (its label AND its raw key, so "trivia"-style
// wording in the label and "reading_challenge" both match). Lower-cased once here, not per keystroke.
function luGuildEventSearchText(ev) {
    return [ev.title, ev.guildName, EVENT_TYPE_LABELS[ev.eventType] || ev.eventType, ev.host === 'inkroot' ? 'official inkroot' : ''].filter(Boolean).join(' ').toLowerCase();
}

const LU_GE_STATUS_PHASE = { published: 'upcoming', active: 'active', completed: 'completed' };


// Adapts a real, backend row (fetchPublicGuildEvents — see
// 51_migration_public_guild_events_directory.sql) into the exact shape LuGuildEventCard already
// renders, so the card itself doesn't need to know real from simulated. `real: true` is what
// gates the card/guild-name actually being clickable — see LuGuildEventCard above.
function luAdaptRealGuildEvent(ev) {
    return {
        ...ev, real: true,
        icon: 'trophy', guildIcon: 'castle',
        cover: ev.coverImageUrl ? `url(${ev.coverImageUrl}) center/cover` : 'linear-gradient(155deg, #B08D5766, #221A24 55%, #14131A 90%)',
    };
}


// "Ends in 2d" / "Ends in 5h" / "Ends in 20m" for a running event. Counts down with the screen's own 15s tick
// (useNowTick in LivingUniverseScreen), so it never needs a refetch.
function luEndsIn(endAt) {
    const ms = endAt - Date.now();
    if (ms <= 60 * 1000) return 'Ending now';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `Ends in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Ends in ${hours}h`;
    return `Ends in ${Math.floor(hours / 24)}d`;
}


// The "Open now" strip at the very top: events that are running right now, soonest-to-end first, each one
// tap away from its own page where the player enters. Real, published, still-running events only - an event
// whose end time has passed is not open, so it stays out even if the server has not closed it yet. Hidden
// entirely when nothing is open (no empty state: the Events section below already has one).
const LU_NOW_MAX = 6;
function LuOpenNow({ events, onOpenEvent, onSeeAll }) {
    if (!events.length) return null;
    const shown = events.slice(0, LU_NOW_MAX);
    return React.createElement("section", { className: "lu-now", "aria-label": "Open now" },
        React.createElement("div", { className: "lu-now-head" },
            React.createElement("h2", { className: "lu-now-title" },
                React.createElement("span", { className: "lu-now-dot", "aria-hidden": "true" }),
                `Open now \u00B7 ${events.length}`),
            React.createElement("button", { type: "button", className: "lu-now-all", onClick: onSeeAll }, "All events \u203A")),
        React.createElement("div", { className: "lu-now-row" },
            shown.map((ev) => React.createElement("button", {
                key: ev.id, type: "button", className: "lu-now-card", onClick: () => onOpenEvent && onOpenEvent(ev.id),
                "aria-label": `${ev.title}, ${luEndsIn(ev.endAt)}. Open to enter`,
            },
                React.createElement("span", { className: "lu-now-guild" },
                    React.createElement("span", { className: "lu-now-guild-name" }, ev.guildName),
                    ev.host === 'inkroot' && React.createElement("span", { className: "lu-now-official" }, "Official")),
                React.createElement("span", { className: "lu-now-name" }, ev.title),
                React.createElement("span", { className: "lu-now-meta" },
                    `${luEndsIn(ev.endAt)} \u00B7 ${formatNaira(ev.prizePoolNaira)} ${ev.host === 'inkroot' ? 'cash prize' : 'prize pool'} \u00B7 ${ev.entryFeeNaira ? formatNaira(ev.entryFeeNaira) + ' entry' : 'Free entry'}`),
                React.createElement("span", { className: "lu-now-enter" }, "Enter \u2192")))));
}


// One warm empty state: an engraved glyph, a serif line, one sentence saying what it means, and (only
// when there is an obvious next step) a single gold button.
function LuEmpty({ icon, title, body, actionLabel, onAction }) {
    return React.createElement("div", { className: "lu-empty" },
        React.createElement("div", { className: "lu-empty-icon" }, React.createElement(InkIcon, { name: icon, size: 20, color: LU_GOLD })),
        React.createElement("h3", { className: "lu-empty-title" }, title),
        React.createElement("p", { className: "lu-empty-body" }, body),
        actionLabel && onAction && React.createElement("button", { type: "button", className: "lu-empty-btn", onClick: onAction }, actionLabel));
}


// Makes a card a real tap target (keyboard + screen-reader friendly) only when it has somewhere to go.
function luTapProps(onActivate) {
    if (!onActivate) return {};
    return { role: 'button', tabIndex: 0, className: 'lu-tap', onClick: onActivate,
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); } } };
}


function luFullDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

function luCount(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }


// The one detail sheet every card on this screen opens. `sheet` is a plain object built by the screen:
//   { icon, color, eyebrow, title, subtitle, body, facts: [{ label, value }], action: { label, run },
//     note, related: [feed entries] }
// Everything on it comes from real data already loaded on this screen - nothing is fetched or invented
// here. Tapping the dark backdrop, the close button or pressing Escape closes it; focus moves in on open
// and back to the card on close; the page behind does not scroll while it is open.
function LuEntrySheet({ sheet, onClose, onOpenRelated }) {
    const closeRef = useRef(null);
    const isOpen = !!sheet;
    useEffect(() => {
        if (!isOpen) return undefined;
        const prevFocus = document.activeElement;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        if (closeRef.current) closeRef.current.focus();
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
            if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
        };
    }, [isOpen]);
    if (!sheet) return null;
    const facts = (sheet.facts || []).filter((f) => f && f.value !== undefined && f.value !== null && f.value !== '');
    return createPortal(
        React.createElement("div", { className: "lu-sheet-backdrop", onClick: onClose },
            React.createElement("div", { className: "lu-sheet", role: "dialog", "aria-modal": "true", "aria-label": sheet.title, style: { '--lu-sheet-color': sheet.color || '#B08D57' }, onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "lu-sheet-grab", "aria-hidden": "true" }),
                React.createElement("button", { type: "button", className: "lu-sheet-close", ref: closeRef, "aria-label": "Close", onClick: onClose }, "\u00D7"),
                React.createElement("div", { className: "lu-sheet-head" },
                    React.createElement("div", { className: "lu-sheet-seal" }, React.createElement(LuGlyph, { value: sheet.icon, size: 19 })),
                    React.createElement("div", { className: "lu-sheet-eyebrow" }, sheet.eyebrow)),
                React.createElement("h2", { className: "lu-sheet-title" }, sheet.title),
                sheet.subtitle && React.createElement("p", { className: "lu-sheet-sub" }, sheet.subtitle),
                sheet.body && React.createElement("p", { className: "lu-sheet-body" }, sheet.body),
                facts.length > 0 && React.createElement("dl", { className: "lu-sheet-facts" },
                    facts.map((f) => React.createElement("div", { className: "lu-sheet-fact", key: f.label },
                        React.createElement("dt", null, f.label),
                        React.createElement("dd", null, f.value)))),
                sheet.action
                    ? React.createElement("button", { type: "button", className: "lu-sheet-action", onClick: () => { onClose(); sheet.action.run(); } }, sheet.action.label)
                    : React.createElement("p", { className: "lu-sheet-note" }, sheet.note || "Nothing more to open here yet."),
                sheet.related && sheet.related.length > 0 && React.createElement(React.Fragment, null,
                    React.createElement("div", { className: "lu-sheet-related-title" }, sheet.relatedTitle || "Also happening"),
                    sheet.related.map((r) => React.createElement("button", { type: "button", className: "lu-sheet-related", key: r.id, onClick: () => onOpenRelated(r) },
                        React.createElement("span", null, r.title),
                        React.createElement("span", null, luTimeAgo(r.ts))))))),
        document.body);
}



// ---- Live-feed helpers ----

function luFollowGroupTitle(names, whom) {
    const uniq = Array.from(new Set(names));
    if (uniq.length <= 1) return `${uniq[0]} started following ${whom}`;
    if (uniq.length === 2) return `${uniq[0]} and ${uniq[1]} started following ${whom}`;
    const rest = uniq.length - 2;
    return `${uniq[0]}, ${uniq[1]} and ${rest} ${rest === 1 ? 'other' : 'others'} started following ${whom}`;
}

// Consecutive "started following <same writer>" rows collapse into one line so a burst of follows
// reads as one happening instead of flooding the Chronicle. Input is newest-first; the group keeps
// the newest row's id/time.
function luGroupFollows(list) {
    const out = [];
    for (const e of list) {
        const prev = out[out.length - 1];
        if (e.kind === 'follow' && e.followee && prev && prev.kind === 'follow' && prev.followee === e.followee) {
            prev.followers.push(e.follower);
            prev.count += 1;
            continue;
        }
        out.push(e.kind === 'follow' && e.followee ? { ...e, followers: [e.follower], count: 1 } : e);
    }
    return out.map((g) => (g.count > 1 ? { ...g, title: luFollowGroupTitle(g.followers, g.followee) } : g));
}

const LU_FILTERS = [['all', 'All'], ['release', 'Releases'], ['review', 'Reviews'], ['follow', 'Followers'], ['guild', 'Guilds']];
const LU_SKEL_WIDTHS = [['78%', '46%'], ['64%', '38%'], ['86%', '52%'], ['58%', '34%'], ['72%', '44%']];

function LuSkeletonRows({ rows = 4 }) {
    return React.createElement("div", { "aria-hidden": "true" },
        Array.from({ length: rows }, (_, i) => React.createElement("div", { key: i, className: "lu-skel-row" },
            React.createElement("div", { className: "lu-skel lu-skel-seal" }),
            React.createElement("div", { style: { flex: 1 } },
                React.createElement("div", { className: "lu-skel lu-skel-line", style: { width: LU_SKEL_WIDTHS[i % LU_SKEL_WIDTHS.length][0] } }),
                React.createElement("div", { className: "lu-skel lu-skel-line", style: { width: LU_SKEL_WIDTHS[i % LU_SKEL_WIDTHS.length][1], height: 10 } })))));
}

function LuSkeletonShelf() {
    return React.createElement("div", { className: "lu-ge-shelf", "aria-hidden": "true", style: { overflow: 'hidden' } },
        [0, 1, 2].map((i) => React.createElement("div", { key: i, className: "lu-skel lu-skel-card" })));
}

// Compact title block: the title on the left, the "Live" status on the right of the same row, and the real
// counts as one inline strip underneath. The explanatory paragraph that used to sit here is gone on purpose -
// a reader who tapped Universe already knows what it is, and the first Chronicle entry and the "Open now"
// strip now reach the screen without a scroll. `stats` is [{ value, label }] of real counts only.
function LuHero({ stats, live }) {
    return React.createElement("div", { className: "lu-hero" },
        React.createElement("div", { className: "lu-hero-top" },
            React.createElement("h1", { className: "lu-hero-title" }, "The Living Universe"),
            live),
        stats.length > 0 && React.createElement("div", { className: "lu-hero-stats" },
            stats.map((st) => React.createElement("span", { key: st.label, className: "lu-hero-stat" },
                React.createElement("b", null, st.value), " ", st.label))));
}

// The Living Universe shows real activity only. Every list below is fetched from the server; when a
// list is empty it is either hidden (rankings that need a few days of real data) or replaced by an
// honest empty state (the Chronicle and Guild Events, which are the heart of the screen).
// One collapsed row on the Universe: the four rankings (Rising Stars, Best Sellers, Most Read, Guilds on the Rise),
// Trending Now and Reader Activity sit behind these rows, each showing how many entries it holds and (for the
// ranked lists) who is number one, so the page reads as a short list of headings instead of nine long sections.
// The look itself is the shared Fold (shared-ui/ui-primitives.jsx). This wrapper keeps the section's id and
// data-lu-jump so the jump row and its highlight still find it; the list is only mounted while the row is open.
function LuFold({ id, icon, label, summary, color, open, onToggle, note, jump = true, wrapStyle, children }) {
    // `jump: false` is for a row with no chip in the jump row: it keeps its id but drops data-lu-jump, so the
    // highlight observer never lands on a section that has no chip to light up.
    const wrapperProps = Object.assign({ className: "lu-section", id: "lu-sec-" + id }, jump ? { "data-lu-jump": id } : null);
    return React.createElement(Fold, { icon, title: label, summary, color, open, onToggle, ellipsis: true, wrapperProps, style: wrapStyle },
        note && React.createElement("p", { style: { margin: '0 0 12px', fontSize: TYPE_SCALE[12.5], lineHeight: 1.6, color: '#A39C8C' } }, note),
        children);
}


// One "Charts" section instead of four near-identical folds (Trending, Rising Stars, Best Sellers, Most Read).
// A segmented control switches between the lists; each tab keeps its own short one-line caption saying what
// the ranking means (the longer methodology copy that used to sit above every fold is dropped). `tabs` is
// [{ id, label, caption, rows: [ReactElement] }] and only holds tabs that actually have rows, so a segment
// never opens onto nothing. The chosen tab is held by the screen (see `chartTab`) so it survives the
// Chronicle's live refreshes; if the chosen tab has no rows any more the first available one shows.
function LuCharts({ tabs, active, onChange }) {
    const current = tabs.find((t) => t.id === active) || tabs[0];
    const onKey = (e) => {
        const i = tabs.findIndex((t) => t.id === current.id);
        let n = -1;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n < 0) return;
        e.preventDefault();
        onChange(tabs[n].id);
        const btn = e.currentTarget.parentNode.querySelectorAll('[role="tab"]')[n];
        if (btn) btn.focus();
    };
    return React.createElement("div", { className: "lu-section", id: "lu-sec-charts", "data-lu-jump": "charts" },
        React.createElement(LuSectionHeader, { title: "Charts" }),
        tabs.length > 1 && React.createElement("div", { className: "lu-seg", role: "tablist", "aria-label": "Choose a chart" },
            tabs.map((t) => React.createElement("button", {
                key: t.id, type: "button", role: "tab", id: "lu-tab-" + t.id, className: "lu-seg-btn",
                "aria-selected": t.id === current.id, "aria-controls": "lu-chart-panel", tabIndex: t.id === current.id ? 0 : -1,
                onClick: () => onChange(t.id), onKeyDown: onKey,
            }, t.label))),
        React.createElement("div", { id: "lu-chart-panel", role: "tabpanel", "aria-labelledby": "lu-tab-" + current.id },
            React.createElement("p", { className: "lu-chart-caption" }, current.caption),
            current.rows));
}


// Sticky jump row. It owns its own hooks (active chip, observer, scroll-into-view) and is only mounted once the
// Universe has data: LivingUniverseScreen returns early while `entries` is still null, so hooks declared in the
// screen body below that early return would run in a different number on the first and second render and React
// would throw. Keeping them in this child keeps the screen's own hook order untouched.
function LuJumpRow({ items, onBeforeJump }) {
    const jumpKey = items.map((j) => j.id).join(',');
    const [activeJump, setActiveJump] = useState(items.length ? items[0].id : 'events');
    const jumpRowRef = useRef(null);
    const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Highlight the chip for the section currently near the top of the screen.
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') return undefined;
        const els = Array.from(document.querySelectorAll('.lu-universe [data-lu-jump]'));
        if (!els.length) return undefined;
        const visible = new Set();
        const io = new IntersectionObserver((list) => {
            list.forEach((en) => {
                const id = en.target.getAttribute('data-lu-jump');
                if (en.isIntersecting) visible.add(id); else visible.delete(id);
            });
            const first = els.map((e) => e.getAttribute('data-lu-jump')).find((id) => visible.has(id));
            if (first) setActiveJump(first);
        }, { rootMargin: '-80px 0px -55% 0px' });
        els.forEach((e) => io.observe(e));
        return () => io.disconnect();
    }, [jumpKey]);
    // Keep the highlighted chip visible inside the sideways-scrolling row.
    useEffect(() => {
        const row = jumpRowRef.current;
        const btn = row && row.querySelector('[aria-current="true"]');
        if (!btn) return;
        const left = btn.offsetLeft - (row.clientWidth - btn.offsetWidth) / 2;
        if (row.scrollTo) row.scrollTo({ left, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); else row.scrollLeft = left;
    }, [activeJump]);
    const goToSection = (id) => {
        const el = document.getElementById('lu-sec-' + id);
        if (!el) return;
        if (onBeforeJump) onBeforeJump(id);
        setActiveJump(id);
        el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    };
    return React.createElement("nav", { className: "lu-jump", "aria-label": "Jump to a section" },
        React.createElement("div", { className: "lu-jump-row", ref: jumpRowRef },
            items.map((j) => React.createElement("button", {
                key: j.id, type: "button", className: "lu-jump-chip", "aria-current": activeJump === j.id ? 'true' : undefined,
                onClick: () => goToSection(j.id),
            }, j.label))));
}

export function LivingUniverseScreen({ onRead, onOpenAuthor, onOpenGuild, onOpenEvent, onGoLibrary, refreshSignal = 0 }) {
    const { entries, failed, pending, showPending, freshIds, refresh, updatedAt, stale, refreshing } = useLivingUniverseFeed();
    useNowTick(15000); // keeps "3m ago" and "updated 12s ago" counting without any refetch
    const [chronicleFilter, setChronicleFilter] = useState('all');
    const chronicleRef = useRef(null);

    // null = still loading, [] = loaded but genuinely empty (or unreachable).
    const [remoteGuildEvents, setRemoteGuildEvents] = useState(null);
    const [remoteRisingStars, setRemoteRisingStars] = useState(null);
    const [remoteBestSellers, setRemoteBestSellers] = useState(null);
    const [remoteMostRead, setRemoteMostRead] = useState(null);
    const [remoteTrending, setRemoteTrending] = useState(null);
    const [remoteGuildsOnRise, setRemoteGuildsOnRise] = useState(null);
    // Runs on mount and again whenever the Universe tab is tapped while already open (`refreshSignal`). On a
    // re-run the lists are only replaced by a non-empty answer, so a dropped connection never blanks charts
    // that are already on screen.
    useEffect(() => {
        let cancelled = false;
        const again = refreshSignal > 0;
        const put = (setter) => (rows) => {
            if (cancelled) return;
            const next = rows || [];
            setter((prev) => (again && prev && prev.length && !next.length ? prev : next));
        };
        fetchPublicGuildEvents().then(put(setRemoteGuildEvents)).catch(put(setRemoteGuildEvents));
        fetchRisingStars({ limit: 6 }).then(put(setRemoteRisingStars)).catch(put(setRemoteRisingStars));
        fetchBestSellers({ limit: 5 }).then(put(setRemoteBestSellers)).catch(put(setRemoteBestSellers));
        fetchMostRead({ limit: 5 }).then(put(setRemoteMostRead)).catch(put(setRemoteMostRead));
        fetchTrending({ limit: 5 }).then(put(setRemoteTrending)).catch(put(setRemoteTrending));
        fetchGuildsOnRise({ limit: 4 }).then(put(setRemoteGuildsOnRise)).catch(put(setRemoteGuildsOnRise));
        return () => { cancelled = true; };
    }, [refreshSignal]);

    const [eventQuery, setEventQuery] = useState('');
    const eventQueryNorm = eventQuery.trim().toLowerCase();
    const [visibleCount, setVisibleCount] = useState(10);
    // Which ranking rows are open (see LuFold); everything starts closed. Declared up here, above the early return
    // for the loading state, so the screen runs the same hooks on every render.
    const [openFolds, setOpenFolds] = useState({});
    // Which tab of the merged Charts section is showing ('' = the first one that has rows).
    const [chartTab, setChartTab] = useState('');
    // The Completed events row inside Guild Events; closed until tapped, since finished contests are history.
    const [completedOpen, setCompletedOpen] = useState(false);
    const [sheet, setSheet] = useState(null);
    // A second tap on the Universe tab (see HomeScreen.changeHomeTab) scrolls to the top and lands here: check
    // for news now, then reveal whatever arrived so the newest happening is the first thing on screen. Skips the
    // very first render (signal 0), which is just the screen opening.
    const lastSignalRef = useRef(refreshSignal);
    useEffect(() => {
        if (refreshSignal === lastSignalRef.current) return;
        lastSignalRef.current = refreshSignal;
        let cancelled = false;
        (async () => {
            await refresh();
            if (cancelled) return;
            showPending();
            setChronicleFilter('all');
        })();
        return () => { cancelled = true; };
    }, [refreshSignal]);

    if (!entries) {
        return React.createElement("div", { className: "ink-page-in lu-universe", "aria-busy": "true" },
            React.createElement(LuHero, { stats: [], live: null }),
            React.createElement("div", { className: "lu-section" },
                React.createElement("span", { className: "lu-sr", role: "status" }, "Opening the Chronicle\u2026"),
                React.createElement(LuSectionHeader, { title: "Chronicle" }),
                React.createElement("div", { className: "lu-chronicle" }, React.createElement(LuSkeletonRows, { rows: 5 }))));
    }

    const risingStars = remoteRisingStars || [];
    const bestSellers = remoteBestSellers || [];
    const mostRead = remoteMostRead || [];
    const trending = remoteTrending || [];
    const guildsOnRise = remoteGuildsOnRise || [];
    const guildEventsVisible = (remoteGuildEvents || []).map(luAdaptRealGuildEvent);

    const releases = entries.filter((e) => e.kind === 'release').slice(0, 8);
    const readerActivity = entries.filter((e) => e.kind === 'review' || e.kind === 'follow').slice(0, 6);
    const publishedToday = entries.filter((e) => e.kind === 'release' && Date.now() - e.ts < 1000 * 60 * 60 * 24).length;

    // Only approved and published Guild Events ever reach this screen - gated server-side (see
    // fetchPublicGuildEvents / list_public_guild_events). Phase comes from the event's own approval status.
    const gePhase = (e) => LU_GE_STATUS_PHASE[e.approvalStatus] || 'upcoming';
    const guildEventsSearched = eventQueryNorm ? guildEventsVisible.filter((e) => luGuildEventSearchText(e).includes(eventQueryNorm)) : guildEventsVisible;
    // Running right now, from the UNFILTERED list: the Events search box below narrows its own rows, never this strip.
    const openNowEvents = guildEventsVisible
        .filter((e) => e.real && gePhase(e) === 'active' && e.endAt > Date.now())
        .sort((a, b) => a.endAt - b.endAt);
    const seeAllEvents = () => {
        const el = document.getElementById('lu-sec-events');
        if (!el) return;
        const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    };
    const upcomingGuildEvents = guildEventsSearched.filter((e) => gePhase(e) === 'upcoming').sort((a, b) => a.startAt - b.startAt);
    const activeGuildEvents = guildEventsSearched.filter((e) => gePhase(e) === 'active').sort((a, b) => a.endAt - b.endAt);
    const completedGuildEvents = guildEventsSearched.filter((e) => gePhase(e) === 'completed').sort((a, b) => b.endAt - a.endAt);

    // ---- Live numbers. Real counts only; when the 60-row fetch window is entirely inside the last 24h the
    // true number may be higher, so it is shown with a "+".
    const nowMs = Date.now();
    const DAY_MS = 1000 * 60 * 60 * 24;
    const windowFull = entries.length >= 60 && nowMs - entries[entries.length - 1].ts < DAY_MS;
    const plus = windowFull ? '+' : '';
    const happeningsToday = entries.filter((e) => nowMs - e.ts < DAY_MS).length;
    const eventsRunning = remoteGuildEvents === null ? null : guildEventsVisible.filter((e) => gePhase(e) === 'active').length;
    const heroStats = (entries.length > 0 || eventsRunning > 0) ? [
        { value: `${publishedToday}${plus}`, label: 'Published today' },
        { value: `${happeningsToday}${plus}`, label: 'Happenings today' },
        eventsRunning !== null ? { value: eventsRunning, label: 'Events running' } : null,
    ].filter(Boolean) : [];
    const rankingsLoading = [remoteRisingStars, remoteBestSellers, remoteMostRead, remoteTrending, remoteGuildsOnRise].some((x) => x === null);
    const offline = failed && entries.length === 0;
    const liveLine = (updatedAt > 0 || offline) && React.createElement("div", { className: "lu-live" },
        React.createElement("button", { type: "button", className: "lu-live-btn", onClick: refresh, disabled: refreshing, "aria-label": "Refresh the Living Universe" },
            React.createElement("span", { className: 'lu-live-dot ' + ((stale || offline) ? 'is-stale' : 'is-live'), "aria-hidden": "true" }),
            offline ? "Can\u2019t reach the Chronicle \u00B7 tap to retry"
                : stale ? "Reconnecting \u00B7 showing the last update"
                : refreshing ? "Checking for news\u2026"
                : `Live \u00B7 updated ${luUpdatedAgo(updatedAt)}`));

    // ---- Chronicle filtering + grouping
    const kindCounts = entries.reduce((m, e) => { m[e.kind] = (m[e.kind] || 0) + 1; return m; }, {});
    const availableFilters = LU_FILTERS.filter(([k]) => k === 'all' || kindCounts[k]);
    const activeFilter = availableFilters.some(([k]) => k === chronicleFilter) ? chronicleFilter : 'all';
    const chronicleItems = luGroupFollows(activeFilter === 'all' ? entries : entries.filter((e) => e.kind === activeFilter));
    const liveCutoff = nowMs - 15 * 60 * 1000;
    const showNewHappenings = () => {
        showPending();
        setChronicleFilter('all');
        const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        setTimeout(() => { if (chronicleRef.current) chronicleRef.current.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }, 60);
    };

    // ---- Detail sheet content. Each builder turns one real row into the plain object LuEntrySheet renders.
    const bookAction = (bookId) => (onRead && bookId ? { label: 'Open this book', run: () => onRead(bookId) } : null);
    const guildAction = (guildId) => (onOpenGuild && guildId ? { label: 'Visit the guild hall', run: () => onOpenGuild(guildId) } : null);
    const genreFact = (genre) => (genre ? { label: 'Genre', value: luGuildNameForGenre(genre) } : null);

    const sheetFromEntry = (e) => {
        const when = { label: 'When', value: `${luTimeAgo(e.ts)} \u00B7 ${luFullDate(e.ts)}` };
        switch (e.kind) {
            case 'release':
                return { icon: 'book', color: LU_GOLD, eyebrow: 'New release', title: e.book, subtitle: `by ${e.author}`,
                    body: `${e.author} has just published this book on Inkroot.`,
                    facts: [genreFact(e.genre), { label: 'Published', value: luFullDate(e.ts) }],
                    action: bookAction(e.bookId), note: 'This book can\u2019t be opened from here.',
                    related: entries.filter((x) => x.id !== e.id && x.bookId && x.bookId === e.bookId).slice(0, 3), relatedTitle: 'Readers say' };
            case 'review':
                return { icon: 'candle', color: LU_GOLD, eyebrow: 'Reader review', title: e.book, subtitle: e.title,
                    body: 'A reader shared what they thought of this book.',
                    facts: [typeof e.rating === 'number' ? { label: 'Rating', value: `${e.rating} of 5 \u2605` } : null, when],
                    action: bookAction(e.bookId), note: 'This book can\u2019t be opened from here.',
                    related: entries.filter((x) => x.id !== e.id && x.bookId && x.bookId === e.bookId).slice(0, 3), relatedTitle: 'More about this book' };
            case 'follow':
                return { icon: 'candle', color: LU_GOLD, eyebrow: e.count > 1 ? 'New followers' : 'New follower', title: e.title,
                    body: e.count > 1 ? `${e.count} readers started following ${e.followee} around the same time.` : 'Readers follow writers so they hear the moment something new is published.',
                    facts: [e.count > 1 ? { label: 'New followers', value: e.count } : null, when], note: 'Follows are shown as they happen, so there is nothing further to open.' };
            case 'guild':
                return { icon: 'castle', color: LU_GOLD, eyebrow: 'Guild hall', title: e.title,
                    body: 'Guild halls are where writers gather to share work, take on quests and enter contests together.',
                    facts: [e.guildName ? { label: 'Guild', value: e.guildName } : null, when],
                    action: guildAction(e.guildId), note: 'This guild hall can\u2019t be opened from here.',
                    related: entries.filter((x) => x.id !== e.id && x.guildId && x.guildId === e.guildId).slice(0, 3), relatedTitle: 'Recently in this hall' };
            default:
                return { icon: 'scroll', color: LU_GOLD, eyebrow: e.tag || 'Chronicle', title: e.title, facts: [when] };
        }
    };
    const sheetFromTrending = (b) => ({ icon: 'flame', color: LU_GOLD, eyebrow: 'Trending now', title: b.title, subtitle: `by ${b.authorName}`,
        body: 'Readers have been opening this book a lot over the last few days.',
        facts: [genreFact(b.genre), { label: 'Readers', value: b.distinctSignedInViewers }, { label: 'Opens', value: b.viewEvents }],
        action: bookAction(b.bookId) });
    const sheetFromBestSeller = (b) => ({ icon: 'crown', color: LU_GOLD, eyebrow: 'Best seller', title: b.title, subtitle: `by ${b.authorName}`,
        body: 'Ranked by real, verified purchases, weighted toward recent sales.',
        facts: [genreFact(b.genre), { label: 'Buyers', value: b.distinctBuyers }, { label: 'Recent sales', value: formatNaira(koboToNaira(b.verifiedRevenueKobo)) }],
        action: bookAction(b.bookId) });
    const sheetFromMostRead = (b) => ({ icon: 'library', color: LU_GOLD, eyebrow: 'Most read', title: b.title, subtitle: `by ${b.authorName}`,
        body: 'Ranked by real, verified reader opens. A free book can top this list without a single sale.',
        facts: [{ label: 'Readers', value: b.distinctReaders }, { label: 'Reads', value: b.verifiedReadEvents }],
        action: bookAction(b.bookId) });
    const sheetFromRisingStar = (r) => ({ icon: 'chart', color: LU_GOLD, eyebrow: 'Rising star', title: r.name,
        body: 'A writer gaining readers and followers quickly this week.',
        facts: [r.recentUniqueReaders > 0 ? { label: 'Readers this week', value: r.recentUniqueReaders } : null,
            r.followersGained > 0 ? { label: 'New followers', value: `+${r.followersGained}` } : null,
            r.recentPublishes > 0 ? { label: 'New releases', value: r.recentPublishes } : null],
        action: onOpenAuthor ? { label: 'View author', run: () => onOpenAuthor(r.name, r.authorId) } : null });
    const sheetFromGuildOnRise = (g) => ({ icon: 'castle', color: LU_GOLD, eyebrow: 'Guild on the rise', title: g.name,
        body: 'A guild hall with real momentum this week, judged on activity rather than size.',
        facts: [{ label: 'Members', value: g.memberCount }, g.newMembers > 0 ? { label: 'New members', value: `+${g.newMembers}` } : null,
            g.booksPublished > 0 ? { label: 'Books published', value: g.booksPublished } : null,
            g.questActivity > 0 ? { label: 'Quests completed', value: g.questActivity } : null,
            { label: 'Reputation this week', value: `+${g.reputationGrowth}` }],
        action: guildAction(g.guildId) });


    // ---- Charts: the four near-identical rankings share one row shape and one segmented control.
    const chartRow = (key, rank, onOpen, title, meta, trail, trailColor) => React.createElement("div", Object.assign({ key }, luTapProps(onOpen), { className: 'lu-trend-row lu-tap' }),
        React.createElement("div", { className: "lu-trend-rank" }, rank),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { className: "lu-trend-title" }, title),
            React.createElement("div", { className: "lu-trend-author" }, meta)),
        React.createElement("div", { className: "lu-trend-move", style: { color: trailColor } }, trail));
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const chartTabs = [
        trending.length > 0 && { id: 'trending', label: 'Trending', caption: 'Most opened over the last few days.',
            rows: trending.map((b, i) => chartRow(b.bookId, i + 1, () => setSheet(sheetFromTrending(b)), b.title,
                `${b.authorName} \u00B7 ${luGuildNameForGenre(b.genre)} \u00B7 ${plural(b.distinctSignedInViewers, 'viewer')}`, `${b.viewEvents} ${b.viewEvents === 1 ? 'open' : 'opens'}`, '#B9B3A5')) },
        risingStars.length > 0 && { id: 'rising', label: 'Rising authors', caption: 'Writers gaining readers and followers this week.',
            rows: risingStars.map((r, i) => chartRow(r.authorId, i + 1, () => setSheet(sheetFromRisingStar(r)), r.name,
                [r.recentUniqueReaders > 0 && `${plural(r.recentUniqueReaders, 'reader')} this week`,
                    r.followersGained > 0 && `+${plural(r.followersGained, 'follower')}`,
                    r.recentPublishes > 0 && `${plural(r.recentPublishes, 'new release')}`].filter(Boolean).join(' \u00B7 ') || 'Gaining ground',
                r.readingGrowth > 0 ? `\u2191${r.readingGrowth}` : '\u2014', LU_GOLD)) },
        bestSellers.length > 0 && { id: 'sellers', label: 'Best sellers', caption: 'Verified purchases, weighted toward recent sales.',
            rows: bestSellers.map((b, i) => chartRow(b.bookId, i + 1, () => setSheet(sheetFromBestSeller(b)), b.title,
                `${b.authorName} \u00B7 ${luGuildNameForGenre(b.genre)} \u00B7 ${plural(b.distinctBuyers, 'buyer')}`, formatNaira(koboToNaira(b.verifiedRevenueKobo)), LU_GOLD)) },
        mostRead.length > 0 && { id: 'mostread', label: 'Most read', caption: 'Verified reader opens, free books included.',
            rows: mostRead.map((b, i) => chartRow(b.bookId, i + 1, () => setSheet(sheetFromMostRead(b)), b.title,
                `${b.authorName} \u00B7 ${plural(b.distinctReaders, 'reader')}`, `${b.verifiedReadEvents} ${b.verifiedReadEvents === 1 ? 'read' : 'reads'}`, '#B9B3A5')) },
    ].filter(Boolean);

    const FOLD_IDS = ['guilds', 'readers'];
    const toggleFold = (id) => setOpenFolds((prev) => Object.assign({}, prev, { [id]: !prev[id] }));
    // A jump chip for a collapsed row opens it first, so the list is there when the page scrolls.
    const openFold = (id) => { if (FOLD_IDS.includes(id)) setOpenFolds((prev) => (prev[id] ? prev : Object.assign({}, prev, { [id]: true }))); };
    // Jump row: one chip per section that actually has content on screen, so a chip never scrolls to nothing.
    const jumpItems = [
        { id: 'events', label: 'Events' },
        { id: 'chronicle', label: 'Chronicle' },
        releases.length > 0 && { id: 'releases', label: 'New books' },
        chartTabs.length > 0 && { id: 'charts', label: 'Charts' },
        guildsOnRise.length > 0 && { id: 'guilds', label: 'Guilds' },
    ].filter(Boolean);

    return React.createElement("div", { className: "ink-page-in lu-universe" },

        React.createElement(LuHero, { stats: heroStats, live: liveLine }),

        // Sticky jump row: the Universe is nine sections long, so this is the way to get to Events or the
        // rankings without scrolling past the whole Chronicle.
        React.createElement(LuJumpRow, { items: jumpItems, onBeforeJump: openFold }),

        pending.length > 0 && React.createElement("div", { className: "lu-newpill-wrap" },
            React.createElement("button", { type: "button", className: "lu-newpill", onClick: showNewHappenings },
                `\u2191 ${pending.length} new ${pending.length === 1 ? 'happening' : 'happenings'}`)),

        React.createElement(LuOpenNow, { events: openNowEvents, onOpenEvent, onSeeAll: seeAllEvents }),

        React.createElement("div", { className: "lu-section", id: "lu-sec-events", "data-lu-jump": "events" },
            React.createElement(LuSectionHeader, { title: "Events", icon: "trophy" }),
            remoteGuildEvents === null
                ? React.createElement(LuSkeletonShelf, null)
                : guildEventsVisible.length
                ? React.createElement(React.Fragment, null,
                    React.createElement("input", { type: "search", className: "lu-ge-search", value: eventQuery, placeholder: "Search events, guilds or types\u2026", "aria-label": "Search guild events", onChange: (e) => setEventQuery(e.target.value) }),
                    React.createElement(LuGuildEventGroup, { phase: "active", events: activeGuildEvents, emptyText: eventQueryNorm ? "No matches." : "No events are running at the moment.", onOpenGuild, onOpenEvent }),
                    React.createElement(LuGuildEventGroup, { phase: "upcoming", events: upcomingGuildEvents, emptyText: eventQueryNorm ? "No matches." : "No upcoming events right now \u2014 check back soon.", onOpenGuild, onOpenEvent }),
                    React.createElement(Fold, {
                        icon: "trophy", title: "Completed events", color: '#8F8A80', open: completedOpen, onToggle: () => setCompletedOpen((v) => !v),
                        minHeight: 52, bodyGap: 10, style: { marginTop: 14 },
                        summary: eventQueryNorm
                            ? `${completedGuildEvents.length} matching your search`
                            : (completedGuildEvents.length ? `${completedGuildEvents.length} wrapped up` : 'None yet'),
                    },
                        React.createElement(LuGuildEventGroup, { phase: "completed", hideTitle: true, events: completedGuildEvents, emptyText: eventQueryNorm ? "No matches." : "No events have wrapped up yet.", onOpenGuild, onOpenEvent })))
                : React.createElement(LuEmpty, { icon: "trophy", title: "No contests yet", body: "When a guild publishes an event \u2014 a contest, a sprint or a championship \u2014 it will be listed here for everyone to join." })),

        React.createElement(PlatformPostsFeed, null),

        React.createElement("div", { className: "lu-section", ref: chronicleRef, id: "lu-sec-chronicle", "data-lu-jump": "chronicle" },
            React.createElement(LuSectionHeader, { title: "Chronicle" }),
            entries.length
                ? React.createElement(React.Fragment, null,
                    availableFilters.length > 2 && React.createElement("div", { className: "lu-chips", role: "group", "aria-label": "Filter the Chronicle" },
                        availableFilters.map(([k, label]) => React.createElement("button", {
                            key: k, type: "button", className: "lu-chip", "aria-pressed": activeFilter === k,
                            onClick: () => { setChronicleFilter(k); setVisibleCount(10); },
                        }, label, React.createElement("span", { className: "lu-chip-count" }, k === 'all' ? entries.length : kindCounts[k])))),
                    React.createElement("div", { className: "lu-chronicle" },
                        chronicleItems.slice(0, visibleCount).map((e) => {
                            return React.createElement("div", Object.assign({ key: e.id }, luTapProps(() => setSheet(sheetFromEntry(e))), {
                                className: 'lu-entry lu-tap' + (e.ts >= liveCutoff ? ' lu-entry-live' : '') + (freshIds.has(e.id) ? ' lu-entry-new' : ''),
                                style: { '--lu-seal-color': '#B08D57' },
                            }),
                                React.createElement("div", { className: "lu-entry-seal" }, React.createElement(LuGlyph, { value: e.seal, size: 10.5 })),
                                React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' } },
                                    React.createElement("div", { className: "lu-entry-title" }, e.title),
                                    React.createElement("div", { className: "lu-entry-time" }, luTimeAgo(e.ts))),
                                e.sub && React.createElement("div", { className: "lu-entry-sub" }, e.sub));
                        })),
                    visibleCount < chronicleItems.length && React.createElement("button", {
                        type: "button", className: "lu-more-btn",
                        onClick: () => setVisibleCount((v) => v + 10),
                    }, "Read further back"))
                : failed
                    ? React.createElement(LuEmpty, { icon: "scroll", title: "The Chronicle can\u2019t be reached", body: "Check your connection \u2014 it will fill in on its own as soon as you are back online, or tap the status line above to retry." })
                    : React.createElement(LuEmpty, { icon: "scroll", title: "The shelves are quiet", body: "Nothing has been inked yet. Publish a book and it becomes the first line of this chronicle.",
                        actionLabel: onGoLibrary ? "Visit the Grand Library" : null, onAction: onGoLibrary })),

        releases.length > 0 && React.createElement("div", { className: "lu-section", id: "lu-sec-releases", "data-lu-jump": "releases" },
            React.createElement(LuSectionHeader, { title: "New releases", actionLabel: onGoLibrary ? "See all" : null, onAction: onGoLibrary }),
            React.createElement("div", { className: "lu-shelf" },
                releases.map((e) => React.createElement("div", Object.assign({ key: e.id }, luTapProps(() => setSheet(sheetFromEntry(e))), { className: 'lu-book lu-tap' }),
                    React.createElement("div", { className: "lu-book-cover", style: { background: `linear-gradient(155deg, ${e.color}55, #17151B 70%)` } },
                        React.createElement("div", { className: "lu-book-title" }, e.book)),
                    React.createElement("div", { className: "lu-book-meta" }, e.author))))),

        rankingsLoading && React.createElement("div", { className: "lu-section" }, React.createElement(LuSkeletonRows, { rows: 3 })),

        chartTabs.length > 0 && React.createElement(LuCharts, { tabs: chartTabs, active: chartTab, onChange: setChartTab }),

        guildsOnRise.length > 0 && React.createElement(LuFold, { id: "guilds", icon: "castle", label: "Guilds on the Rise", color: LU_GOLD, summary: `${guildsOnRise.length} ranked \u00B7 #1 ${guildsOnRise[0].name}`, note: "Ranked by real, recent Guild Hall activity \u2014 new members, reads, publishes, quests, and anthology work \u2014 never by guild size, and never gameable by one member alone.", open: !!openFolds.guilds, onToggle: () => toggleFold("guilds") },
                        React.createElement("div", { className: "lu-guild-grid" },
                guildsOnRise.map((g) => React.createElement("div", Object.assign({ key: g.guildId }, luTapProps(() => setSheet(sheetFromGuildOnRise(g))), { className: 'lu-guild-card lu-tap' }),
                    React.createElement("div", { className: "lu-guild-head" },
                        React.createElement("div", { className: "lu-guild-icon" }, React.createElement(InkIcon, { name: "castle", size: 15, color: INBOX_ICON_COLOR })),
                        React.createElement("div", { className: "lu-guild-name" }, g.name)),
                    React.createElement("p", null,
                        [
                            g.newMembers > 0 && `+${g.newMembers} member${g.newMembers === 1 ? '' : 's'}`,
                            g.booksPublished > 0 && `${g.booksPublished} book${g.booksPublished === 1 ? '' : 's'} published`,
                            g.readingActivity > 0 && `${g.readingActivity} reader${g.readingActivity === 1 ? '' : 's'}`,
                            g.questActivity > 0 && `${g.questActivity} quest${g.questActivity === 1 ? '' : 's'} completed`,
                            g.anthologyActivity > 0 && `${g.anthologyActivity} anthology move${g.anthologyActivity === 1 ? '' : 's'}`,
                        ].filter(Boolean).join(' \u00B7 ') || 'Gaining ground'),
                    React.createElement("div", { className: "lu-guild-time" }, `${g.memberCount} member${g.memberCount === 1 ? '' : 's'} \u00B7 +${g.reputationGrowth} Reputation this week`))))),

        readerActivity.length > 0 && React.createElement(LuFold, { id: "readers", icon: "eye", label: "Reader Activity", color: LU_GOLD, jump: false, wrapStyle: { marginBottom: 8 },
            summary: `${readerActivity.length} recent \u00B7 the quiet side of the ledger`,
            open: !!openFolds.readers, onToggle: () => toggleFold("readers") },
            readerActivity.map((e) => {
                return React.createElement("div", Object.assign({ key: e.id }, luTapProps(() => setSheet(sheetFromEntry(e))), { className: 'lu-reader-row lu-tap' }),
                    React.createElement("div", { className: "lu-reader-dot" }),
                    React.createElement("div", { className: "lu-reader-text" }, e.title),
                    React.createElement("div", { className: "lu-reader-time" }, luTimeAgo(e.ts)));
            })),

        React.createElement("div", { className: "lu-foot" },
            "Everything here comes from real activity on Inkroot."),

        React.createElement(LuEntrySheet, { sheet, onClose: () => setSheet(null), onOpenRelated: (r) => setSheet(sheetFromEntry(r)) }));
}
