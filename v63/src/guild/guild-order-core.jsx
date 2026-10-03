import { C } from './guild-theme.js';
import React from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';
import { computeAuthorReputation, reputationTitleFor } from '../library/author-reputation.jsx';
import { LU_AUTHORS } from '../library/inbox-and-living-universe.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Guild Order shared building blocks: roles, permissions, rung helpers, tab list, shared styles and the
// tab bar. The overview of how the Guild Order works (and which parts are real vs simulated) is at the top
// of guild-order.jsx.
export const GO_ROLES = [
    { key: 'guildmaster', label: 'Guild Master', icon: React.createElement(InkIcon, { name: 'crown', size: 12 }), color: C.goldBright, rung: 6 },
    { key: 'council', label: 'Council', icon: React.createElement(InkIcon, { name: 'columns', size: 12 }), color: C.gold, rung: 5 },
    { key: 'editor', label: 'Editor', icon: React.createElement(InkIcon, { name: 'scroll', size: 12 }), color: '#A184D6', rung: 4 },
    { key: 'mentor', label: 'Mentor', icon: React.createElement(InkIcon, { name: 'candle', size: 12 }), color: C.sky, rung: 3 },
    { key: 'writer', label: 'Writer', icon: React.createElement(InkIcon, { name: 'book', size: 12 }), color: '#B08D57', rung: 2 },
    { key: 'apprentice', label: 'Apprentice', icon: React.createElement(InkIcon, { name: 'tree', size: 12 }), color: '#8FA37A', rung: 1 },
];


// A Player Guild's real Treasurer / Officer roles (player_guild_members.role). They aren't rungs on the
// Founder Guild ladder above, so GO_ROLES stays as it was; these are looked up by key only where a
// Player Guild needs to show them (the roster groups, the Guild Order header badge).
export const GO_PLAYER_ROLE_EXTRAS = {
    treasurer: { key: 'treasurer', label: 'Treasurer', icon: React.createElement(InkIcon, { name: 'columns', size: 12 }), color: C.gold, rung: 5 },
    officer: { key: 'officer', label: 'Officer', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 12 }), color: C.gold, rung: 4 },
};


function goRoleByKey(key) { return GO_ROLES.find((r) => r.key === key) || GO_PLAYER_ROLE_EXTRAS[key] || GO_ROLES[GO_ROLES.length - 1]; }


export const GO_PERMISSIONS = {
    proposeChapter: 1, draftChapter: 2, editChapter: 4, approveChapter: 4, lockManuscript: 5,
    addWorldEntry: 2, curateWorldEntry: 4, submitAnthology: 1, manageAnthology: 4,
    spendTreasury: 5, openVote: 5, castVote: 1,
};


// A member's own role is the one thing here that's real, not simulated: whoever runs their own
// guild is its Guild Master; inside a Founder Guild, rung follows the writer's actual Writer Rank
// tier, so climbing WRITER_RANKS for real climbs the guild hierarchy for real too.
export function goPlayerRung(writerRank, isFounderView) {
    if (!isFounderView)
        return 6;
    const tier = (writerRank && writerRank.tier) || 1;
    if (tier >= 9) return 5;
    if (tier >= 7) return 4;
    if (tier >= 5) return 3;
    if (tier >= 3) return 2;
    return 1;
}


// Real rung for a FOUNDER Guild's other members (goPlayerRung above only ever computes the
// current writer's own rung). publishedCount is that member's own quality-length
// (REPUTATION_QUALITY_MIN_WORDS+) published_books count — the same public signal
// AuthorsHallScreen already uses for someone else's Hall, since follow/completed/guild-
// contribution counts aren't knowable about another writer from here. Deliberately mapped onto
// the Reputation ladder's tier (1-6), not re-derived from scratch, so a member's Roster-tab rung
// always matches what their own Writer Rank badge would say. Rung 6 (Guild Master) is reserved
// for a Player Guild's owner (see goRealPlayerRung below) — nobody reaches it via Reputation
// alone here, same as goPlayerRung above never returns 6 for a Founder Guild.
export function goRealFounderRung(publishedCount) {
    const tier = reputationTitleFor(computeAuthorReputation({ publishedCount })).tier;
    if (tier >= 6) return 5;
    if (tier >= 4) return 4;
    if (tier >= 3) return 3;
    if (tier >= 2) return 2;
    return 1;
}


// Real rung for a PLAYER Guild's other members — needs no Reputation lookup at all, unlike the
// Founder Guild case above: owner_id and player_guild_members.role are both real,
// RLS-authoritative fields already (see 44_migration_guild_treasury_roles_and_approvals.sql), so
// this just maps them onto the same rung scale GO_ROLES uses everywhere else.
export function goRealPlayerRung(isOwner, role) {
    if (isOwner) return 6;
    if (role === 'treasurer') return 5;
    if (role === 'officer') return 4;
    return 2;
}


function goHash(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) { h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0; }
    return h >>> 0;
}


function goMulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


// Deterministic per-guild roster: the same guild always shows the same simulated members (so
// re-opening it doesn't reshuffle everyone's identity), while a different guild gets a different
// cast, seeded from its own name.
export function goBuildRoster(guildKey, guildName, playerName, playerRung) {
    const rng = goMulberry32(goHash(guildKey || guildName || 'guild'));
    const pool = [...LU_AUTHORS].sort(() => rng() - 0.5);
    const slotCounts = { 6: 1, 5: 3, 4: 4, 3: 4, 2: 8, 1: 6 };
    const members = [];
    let idx = 0;
    GO_ROLES.forEach((role) => {
        let n = slotCounts[role.rung] || 0;
        if (role.rung === playerRung) n = Math.max(0, n - 1);
        for (let i = 0; i < n; i++) {
            const name = pool[idx % pool.length]; idx++;
            members.push({ id: `npc-${role.key}-${i}`, name, role: role.key, rung: role.rung, contribution: Math.round(20 + rng() * 480) });
        }
    });
    members.push({ id: 'you', name: playerName || 'You', role: goRoleByKey(GO_ROLES.find((r) => r.rung === playerRung).key).key, rung: playerRung, isPlayer: true, contribution: null });
    return members.sort((a, b) => b.rung - a.rung || (b.contribution || 0) - (a.contribution || 0));
}


// REMOVED — GO_CHAPTER_TITLES / goBuildManuscript(roster), the simulated chapter list the
// Manuscript tab used to build from the fake NPC roster. The tab now fetches real chapters from
// guild_order_chapters (migration 65) via fetchGuildManuscript — see GoManuscriptTab and
// lib/guild-manuscript.js.


export const GO_WORLD_CATEGORIES = ['Houses & Orders', 'Magic & Rites', 'Realms & Regions', 'Bestiary', 'Artifacts & Relics'];


export function goBuildAnthologySeed(roster) {
    const contributors = roster.filter((m) => !m.isPlayer).slice(0, 4);
    const titles = ['The Last Ember', 'Between Two Vows', 'What the Guild Remembers', 'A Quiet Reckoning'];
    return contributors.map((m, i) => ({ id: `as-${i}`, title: titles[i % titles.length], author: m.name, words: 2200 + (m.contribution || 50) * 20, ts: Date.now() - i * 86400000 }));
}


export const GO_COMMISSIONS = [
    { id: 'seal', icon: React.createElement(InkIcon, { name: 'coin', size: 18 }), title: 'Commission an Illuminated Guild Seal', cost: 150, desc: 'A hand-drawn seal for official guild correspondence.' },
    { id: 'apprentice', icon: React.createElement(InkIcon, { name: 'tree', size: 18 }), title: "Fund an Apprentice's First Year", cost: 300, desc: "Sponsor a new writer's first year of guild dues." },
    { id: 'banner', icon: React.createElement(InkIcon, { name: 'shield', size: 18 }), title: 'Restore the Guild Banner', cost: 500, desc: 'Reweave the banner hanging in the Hall.' },
    { id: 'feast', icon: React.createElement(InkIcon, { name: 'gift', size: 18 }), title: 'Host a Grand Feast', cost: 250, desc: 'A celebration for the whole guild.' },
    { id: 'scholars', icon: React.createElement(InkIcon, { name: 'library', size: 18 }), title: "Endow the Scholars' Shelf", cost: 400, desc: "Reserve library shelf space for members' research." },
];


// Manuscript and World Bible are no longer separate top-level tabs here — they're consolidated
// inside Guild Anthology (see guild-anthology.jsx's workspace), since a shared manuscript/world
// bible is what an anthology actually needs, not a second, disconnected home for the same
// content. GoManuscriptTab/GoWorldBibleTab themselves are unchanged and still live in this file;
// only their place in the nav moved.
export const GO_TABS = [
    { key: 'roster', label: 'Roster', icon: React.createElement(InkIcon, { name: 'users', size: 13 }) },
    { key: 'anthology', label: 'Guild Anthology', icon: React.createElement(InkIcon, { name: 'library', size: 13 }) },
    { key: 'quests', label: 'Quests', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 13 }) },
    { key: 'events', label: 'Guild Events', icon: React.createElement(InkIcon, { name: 'horn', size: 13 }) },
    { key: 'treasury', label: 'Treasury', icon: React.createElement(InkIcon, { name: 'moneybag', size: 13 }) },
    { key: 'council', label: 'Council', icon: React.createElement(InkIcon, { name: 'columns', size: 13 }) },
];


export function goBtnStyle(primary) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', minHeight: 44, borderRadius: RADIUS_SCALE[8], cursor: 'pointer',
        border: primary ? '1px solid rgba(232,196,104,0.5)' : `1px solid ${C.border}`,
        background: primary ? `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` : 'transparent',
        color: primary ? C.goldBright : C.textSoft,
    };
}


export const goInputStyle = {
    width: '100%', boxSizing: 'border-box', background: C.inputBg, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8],
    padding: '10px 12px', color: C.text, fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit', resize: 'vertical',
};


export function GoTabNav({ active, onSelect }) {
    // All six sections stay visible at every width: a 3 x 2 grid on a phone (icon over label), one wrapped
    // centred row from tablet up. No sideways scrolling, so no tab can hide off-screen. Keyboard follows the
    // WAI-ARIA tabs pattern: only the active tab is in the Tab order, and arrow keys / Home / End move between tabs.
    const rowRef = React.useRef(null);
    const onKeyDown = (e) => {
        const keys = GO_TABS.map((t) => t.key);
        const at = keys.indexOf(active);
        let next = -1;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % keys.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (at - 1 + keys.length) % keys.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = keys.length - 1;
        if (next < 0) return;
        e.preventDefault();
        onSelect(keys[next]);
        const el = rowRef.current && rowRef.current.querySelector(`#go-tab-${keys[next]}`);
        if (el) el.focus();
    };
    return React.createElement(React.Fragment, null,
        React.createElement("style", null, `
          .go-tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:${SPACE_SCALE[6]}px;margin-bottom:${SPACE_SCALE[16]}px;}
          .go-tab{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${SPACE_SCALE[4]}px;min-height:56px;padding:8px 6px;
            border-radius:${RADIUS_SCALE[12]}px;font-family:inherit;font-size:${TYPE_SCALE[12]}px;font-weight:600;line-height:1.2;text-align:center;cursor:pointer;
            border:1px solid ${C.border};background:rgba(36,31,20,0.55);color:#B9B3A5;}
          .go-tab[aria-selected="true"]{border-color:rgba(232,196,104,0.5);background:linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt});color:${C.goldBright};}
          .go-tab:focus-visible{outline:2px solid ${C.goldBright};outline-offset:2px;}
          @media (min-width: 720px){
            .go-tabs{display:flex;flex-wrap:wrap;justify-content:center;}
            .go-tab{flex-direction:row;gap:${SPACE_SCALE[6]}px;min-height:44px;padding:8px 14px;border-radius:${RADIUS_SCALE[100]}px;font-size:${TYPE_SCALE[12.5]}px;white-space:nowrap;}
          }`),
        React.createElement("div", { ref: rowRef, className: "go-tabs", role: "tablist", "aria-label": "Guild Order sections", onKeyDown },
            GO_TABS.map((t) => React.createElement("button", {
                key: t.key, id: `go-tab-${t.key}`, className: "go-tab", type: "button", role: "tab",
                "aria-selected": active === t.key, "aria-controls": "go-panel", tabIndex: active === t.key ? 0 : -1,
                onClick: () => onSelect(t.key),
            }, t.icon, t.label))));
}


export function GoRoleBadge({ role, size }) {
    const r = goRoleByKey(role);
    return React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[5], fontSize: size || 11, fontWeight: 600, color: r.color, border: `1px solid ${r.color}55`, borderRadius: RADIUS_SCALE[100], padding: '3px 9px' } }, r.icon, ' ', r.label);
}


export function GoLocked({ text }) {
    return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, fontStyle: 'italic', textAlign: 'center', padding: '10px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6] } },
        React.createElement(InkIcon, { name: "lock", size: 11 }), text);
}
