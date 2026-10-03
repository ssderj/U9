import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { splitNoticeText } from './notice-board.jsx';

// ---------- Small Guild tab pieces that mirror the Universe's patterns ----------
// Styles are inline on purpose: the Universe's matching classes (.lu-head, .lu-seg, .lu-now) live in a
// Universe-only stylesheet, and the Guild tab should not depend on it.

// One line per section: a short serif label with a small icon in front and, optionally, a quiet real
// count. Replaces the centred icon + letter-spaced title (ArchiveSectionHeading) and its subtitle.
export function GuildSectionHeader({ title, icon, count }) {
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], margin: '0 0 10px', textAlign: 'left' } },
        icon && React.createElement("span", { "aria-hidden": "true", style: { display: 'inline-flex', color: C.gold } }, React.createElement(InkIcon, { name: icon, size: 15, color: "currentColor" })),
        React.createElement("h2", { style: { margin: 0, fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: C.text } }, title),
        count !== undefined && count !== null && React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft } }, count));
}


// Segmented control (same behaviour as the Universe's Charts control: tablist, arrow keys, one panel).
// tabs: [{ id, label, dot }]; a dot marks a tab with something new in it.
export function GuildSegmented({ tabs, active, onChange, label }) {
    const onKey = (e) => {
        const i = tabs.findIndex((t) => t.id === active);
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
    return React.createElement("div", { role: "tablist", "aria-label": label, style: {
            display: 'flex', gap: 2, padding: 3, margin: '0 0 10px', overflowX: 'auto',
            border: '1px solid rgba(232,196,104,0.2)', borderRadius: 100, background: 'rgba(19,18,22,0.7)',
        } },
        tabs.map((t) => {
            const on = t.id === active;
            return React.createElement("button", {
                key: t.id, type: "button", role: "tab", id: 'guild-seg-' + t.id, "aria-selected": on, "aria-controls": 'guild-seg-panel',
                tabIndex: on ? 0 : -1, onClick: () => onChange(t.id), onKeyDown: onKey,
                style: {
                    flex: '1 1 0', minHeight: 40, padding: '0 10px', border: 0, borderRadius: 100, cursor: 'pointer', whiteSpace: 'nowrap',
                    fontFamily: 'inherit', fontSize: TYPE_SCALE[13], fontWeight: on ? 600 : 500,
                    color: on ? C.surfaceDeep : '#B3AD9F',
                    background: on ? `linear-gradient(180deg, #F2D98A, ${C.gold})` : 'none',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                },
            }, t.label,
                t.dot && !on && React.createElement("span", { "aria-label": "new", style: { width: 8, height: 8, borderRadius: '50%', background: C.goldBright, display: 'inline-block' } }));
        }));
}


// ---------- Today in the Guild ----------
// One or two priority items drawn from data the Guild tab has already loaded, nothing fetched for it:
//   1. an event ending within three days   2. an announcement newer than the reader's last visit to
//   the Fireside   3. a quest that is nearly done (75% or more, not yet complete)   4. any event that
//   is running now. Hidden entirely when there is nothing to say.
const TODAY_MAX = 2;
const ENDING_SOON_MS = 3 * 24 * 60 * 60 * 1000;

function eventStatus(event) {
    return event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
}

function endsIn(endMs, now) {
    const mins = Math.max(0, Math.round((endMs - now) / 60000));
    if (mins < 60) return `Ends in ${Math.max(1, mins)}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Ends in ${hours}h`;
    return `Ends in ${Math.floor(hours / 24)}d`;
}

export function buildTodayItems({ events, newNotices, questDefs, lifetimeStats, onOpenEvents, onOpenFireside, onOpenQuests, now = Date.now() }) {
    const items = [];
    (events || []).forEach((e) => {
        if (eventStatus(e) !== 'active') return;
        const endMs = e.end_date ? new Date(e.end_date).getTime() : null;
        if (endMs !== null && endMs <= now) return; // an event past its end time is not running, even if the server has not closed it yet
        const soon = endMs !== null && endMs - now <= ENDING_SOON_MS;
        items.push({
            key: 'event-' + e.id, priority: soon ? 1 : 4, sort: endMs || Infinity, icon: 'horn',
            label: soon ? 'Ending soon' : 'Open now', title: e.title || 'Untitled event',
            meta: endMs !== null ? endsIn(endMs, now) : 'Open for entries', onOpen: onOpenEvents,
        });
    });
    (newNotices || []).slice(0, 1).forEach((n) => {
        const { heading, message } = splitNoticeText(n.body);
        const text = heading || message;
        items.push({
            key: 'notice-' + n.id, priority: 2, sort: -new Date(n.created_at).getTime(), icon: 'scroll',
            label: 'New announcement', title: text.length > 70 ? text.slice(0, 67) + '\u2026' : text,
            meta: n.author_name || 'A guild officer', onOpen: onOpenFireside,
        });
    });
    (questDefs || []).forEach((def) => {
        if (!def.statKey) return;
        const progress = (lifetimeStats && lifetimeStats[def.statKey]) || 0;
        const pct = Math.floor((progress / def.target) * 100);
        if (pct < 75 || pct >= 100) return;
        items.push({ key: 'quest-' + def.id, priority: 3, sort: -pct, icon: 'crossedSwords', label: 'Quest nearly done', title: def.title, meta: `${pct}% complete`, onOpen: onOpenQuests });
    });
    return items.sort((a, b) => a.priority - b.priority || a.sort - b.sort).slice(0, TODAY_MAX);
}

export function GuildTodayStrip({ items }) {
    if (!items || items.length === 0) return null;
    return React.createElement("section", { "aria-label": "Today in the Guild", style: { marginBottom: 22, textAlign: 'left' } },
        React.createElement(GuildSectionHeader, { title: "Today in the Guild", icon: "sparkle" }),
        React.createElement("div", { style: S.col8 },
            items.map((it) => React.createElement("button", { key: it.key, type: "button", onClick: it.onOpen, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], width: '100%', minHeight: 56, padding: '10px 14px', textAlign: 'left',
                    background: `linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12],
                    cursor: 'pointer', fontFamily: 'inherit', color: 'inherit',
                } },
                React.createElement("span", { style: { flexShrink: 0, display: 'inline-flex' } }, React.createElement(InkIcon, { name: it.icon, size: 18, color: C.gold })),
                React.createElement("span", { style: S.fill },
                    React.createElement("span", { style: { display: 'block', fontSize: TYPE_SCALE[10.5], letterSpacing: '0.04em', textTransform: 'uppercase', color: C.gold } }, it.label),
                    React.createElement("span", { style: { display: 'block', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, it.title),
                    React.createElement("span", { style: { display: 'block', marginTop: 1, fontSize: TYPE_SCALE[11.5], color: C.textSoft } }, it.meta)),
                React.createElement("span", { "aria-hidden": "true", style: { flexShrink: 0, fontSize: 20, lineHeight: 1, color: C.textMuted } }, '\u203A')))));
}
