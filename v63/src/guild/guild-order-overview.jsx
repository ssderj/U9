import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';
import { GuildSectionHeader } from './guild-hall-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- Guild Order overview ----------
// The compact directory that replaces the old single generic "The Guild Order" teaser card on
// the Guild Hall home screen. The Guild Order itself (guild-order.jsx) is untouched — this is
// purely a nicer front door onto its six tabs (GO_TABS), one row per area, each carrying its own
// icon, a short live-or-static blurb, and a tap target that opens the Guild Order landed
// straight on that tab (see GuildOrderScreen's initialTab prop and home-screen.jsx's
// pendingGuildOrderTab).
//
// Deliberately a single vertical directory (two columns from tablet width up, via the
// .go-directory CSS grid in app.css) rather than six identical square cards or a horizontal pill
// row — each row reads left-to-right like an entry in a guild ledger: a carved icon medallion,
// the area's name and one line of context, and a small chevron out to it.
const GUILD_ORDER_AREAS = [
    { key: 'roster', label: 'Roster', icon: 'users', blurb: 'See who stands with you' },
    { key: 'anthology', label: 'Anthology', icon: 'book', blurb: 'The guild\u2019s collaborative book' },
    { key: 'quests', label: 'Quests', icon: 'crossedSwords', blurb: 'Shared goals, tracked together' },
    { key: 'events', label: 'Guild Events', icon: 'horn', blurb: 'Competitions and challenges' },
    { key: 'treasury', label: 'Treasury', icon: 'moneybag', blurb: 'Guild funds and member earnings' },
    { key: 'council', label: 'Council', icon: 'columns', blurb: 'Proposals and guild governance' },
];


function GoDirectoryRow({ area, blurb, onSelect, action }) {
    const row = React.createElement("button", {
        onClick: () => onSelect(area.key),
        className: "go-directory-row",
        style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], flex: 1, minWidth: 0, width: '100%', textAlign: 'left',
            padding: '12px 13px', borderRadius: RADIUS_SCALE[12], cursor: 'pointer',
            background: 'linear-gradient(160deg, rgba(36,31,20,0.55), rgba(23,19,15,0.55))',
            border: '1px solid rgba(74,61,34,0.6)', font: 'inherit', color: 'inherit',
        },
    },
        React.createElement("div", {
            style: {
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: `radial-gradient(circle at 34% 30%, ${C.surfaceRaised}, ${C.surfaceInk} 75%)`, border: '1px solid rgba(232,196,104,0.4)',
            },
        }, React.createElement(InkIcon, { name: area.icon, size: 18, color: C.goldBright })),
        React.createElement("div", { style: S.fill },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: C.text } }, area.label),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, blurb)),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[15], color: C.textMuted, flexShrink: 0, marginLeft: 2 } }, "\u203A"));
    if (!action) return row;
    // Owner-only shortcut (e.g. + New event) beside the row: a sibling button, since a button cannot sit inside one.
    return React.createElement("div", { style: { display: 'flex', alignItems: 'stretch', gap: SPACE_SCALE[8] } },
        row,
        React.createElement("button", { type: "button", onClick: action.onClick, "aria-label": action.ariaLabel, style: {
                flexShrink: 0, minWidth: 64, minHeight: 44, padding: '0 12px', borderRadius: RADIUS_SCALE[12], cursor: 'pointer',
                background: 'none', border: `1px solid ${C.borderStrong}`, color: C.gold, fontFamily: 'inherit', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
            } }, action.label));
}


// The ornamented card with "Six chambers of the guild, one hall" is gone: one plain header line now.
// `overrides` optionally replaces a specific area's static blurb with a live one-liner (a member/online
// count for Roster, event and anthology counts, a completed/total tally for Quests) — anything not present
// there just falls back to GUILD_ORDER_AREAS' own description.
export function GuildOrderOverview({ onSelect, overrides, actions }) {
    return React.createElement("div", { style: { marginBottom: 22, textAlign: 'left' } },
        React.createElement(GuildSectionHeader, { title: "Guild Order", icon: "columns" }),
        React.createElement("div", { className: "go-directory" },
            GUILD_ORDER_AREAS.map((area) => React.createElement(GoDirectoryRow, {
                key: area.key, area, onSelect, action: actions && actions[area.key],
                blurb: (overrides && overrides[area.key]) || area.blurb,
            }))));
}
