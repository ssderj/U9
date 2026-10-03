import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState } from 'react';
import { ProgressBar } from '../shared-ui/ui-cards.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
// Reused, not reinvented: the anthology's cover is the exact same structured object
// (style/accent/motif) a solo book's cover already is (see 35_migration_guild_anthologies.sql's
// header) — so its picker is the same three selects + the same BookCover render everywhere else
// in Inkroot uses, not a second cover system just for anthologies.
import { BookCover, COVER_ACCENTS, COVER_MOTIFS, COVER_STYLES } from '../worldbuilding/book-cover.jsx';
import { goBtnStyle, goInputStyle } from './guild-order-core.jsx';

// The original fake, word-count-split preview content — kept as the honest fallback for anyone
// signed out or offline (see this file's HONESTY NOTE — a Founder Guild gets the real thing now
// too, same as a Player Guild). Nothing here is real: state.anthologySubmissions is this device's
// own local-only storage, same as every other GoState field, and the split shown is illustrative,
// not a real payout. Exported (banner-less, on purpose) so guild-anthology.jsx's simulated workspace can
// drop it straight into its own Overview tab, inside the same desk-plate/tab chrome the real
// workspace uses — the content itself is unchanged from what always rendered here, only the
// surrounding banner (now owned by the caller) has moved.
export function GoAnthologyOverviewSimulated({ guild, seedSubs, state, patchState, projects, playerName }) {
    const [showPicker, setShowPicker] = useState(false);
    const submissions = [...seedSubs, ...state.anthologySubmissions];
    const totalWords = submissions.reduce((s, x) => s + x.words, 0) || 1;
    const eligible = (projects || []).filter((p) => (p.wordCount || 0) > 0 && !state.anthologySubmissions.some((s) => s.id === `pj-${p.id}`));
    const submit = (p) => {
        patchState({ anthologySubmissions: [...state.anthologySubmissions, { id: `pj-${p.id}`, title: p.title, author: playerName || 'You', words: p.wordCount || 0, ts: Date.now(), isPlayer: true }] });
        setShowPicker(false);
    };
    const byContributor = {};
    submissions.forEach((s) => { byContributor[s.author] = (byContributor[s.author] || 0) + s.words; });
    const splits = Object.entries(byContributor).map(([author, words]) => ({ author, words, pct: Math.round((words / totalWords) * 1000) / 10 })).sort((a, b) => b.words - a.words);
    return React.createElement("div", null,
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 20 } },
            React.createElement("button", { onClick: () => setShowPicker((s) => !s), style: goBtnStyle(true) }, showPicker ? 'Cancel' : 'Submit your work')),
        showPicker && React.createElement("div", { style: { marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            eligible.length === 0 ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, textAlign: 'center' } }, 'No eligible manuscripts to submit yet.')
                : eligible.map((p) => React.createElement("button", { key: p.id, onClick: () => submit(p), style: { ...goBtnStyle(false), textAlign: 'left' } }, `${p.title} (${(p.wordCount || 0).toLocaleString()} words)`))),
        React.createElement("div", { style: S.sectionLabel }, `Contributors (${submissions.length})`),
        submissions.map((s) => React.createElement("div", { key: s.id, className: "gw-slip" },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12.5], color: C.text } },
                React.createElement("span", null, `${s.title} \u2014 ${s.author}${s.isPlayer ? ' (you)' : ''}`),
                React.createElement("span", { style: { color: C.textSoft, fontSize: TYPE_SCALE[11] } }, `${s.words.toLocaleString()} words`)))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textMuted, margin: '22px 0 10px' } }, 'Projected Revenue Split'),
        splits.map((s) => React.createElement("div", { key: s.author, style: { marginBottom: 10 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12], color: C.textSoft, marginBottom: 3 } },
                React.createElement("span", null, s.author), React.createElement("span", null, `${s.pct}%`)),
            React.createElement(ProgressBar, { value: s.words, max: totalWords, color: C.gold }))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, fontStyle: 'italic', marginTop: 14, textAlign: 'center' } }, "Split by contributed word count, shown for planning \u2014 Inkroot doesn't process real anthology sales yet."));
}


// The same style/accent/motif picker a book cover already uses, wherever a cover object needs
// editing — just the three selects plus a live BookCover preview, sized down for an inline form.
export function GoCoverPicker({ title, cover, onChange }) {
    const styleKey = (cover && COVER_STYLES[cover.style]) ? cover.style : 'leather';
    const accentKey = (cover && COVER_ACCENTS[cover.accent]) ? cover.accent : 'gold';
    const motifKey = cover && Object.prototype.hasOwnProperty.call(COVER_MOTIFS, cover.motif) ? cover.motif : 'compass';
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start' } },
        React.createElement(BookCover, { title: title || 'Untitled', author: '', cover: { style: styleKey, accent: accentKey, motif: motifKey }, size: 'sm' }),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("select", { value: styleKey, onChange: (e) => onChange({ style: e.target.value, accent: accentKey, motif: motifKey }), style: goInputStyle },
                Object.keys(COVER_STYLES).map((k) => React.createElement("option", { key: k, value: k }, k))),
            React.createElement("select", { value: accentKey, onChange: (e) => onChange({ style: styleKey, accent: e.target.value, motif: motifKey }), style: goInputStyle },
                Object.keys(COVER_ACCENTS).map((k) => React.createElement("option", { key: k, value: k }, k))),
            React.createElement("select", { value: motifKey, onChange: (e) => onChange({ style: styleKey, accent: accentKey, motif: e.target.value }), style: goInputStyle },
                Object.keys(COVER_MOTIFS).map((k) => React.createElement("option", { key: k, value: k }, k)))));
}


// Who can do what — the anthology's authority model is simpler than the rest of the Guild Order
// (owner-only for every write except a contributor's own submission/approval, see this file's
// header comment on GO_PERMISSIONS not applying here), so it's spelled out once, plainly, rather
// than left for a writer to infer from which buttons happen to be disabled.
export function GoAnthologyPermissionsNote({ isOwner }) {
    const [expanded, setExpanded] = useState(false);
    return React.createElement("div", {
        style: {
            fontSize: TYPE_SCALE[10.5], color: C.textSoft, lineHeight: 1.6, background: C.surface,
            border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[10], padding: '10px 12px', marginBottom: 18,
        },
    },
        !expanded
            ? React.createElement("button", {
                onClick: () => setExpanded(true),
                style: { background: 'none', border: 'none', padding: 0, color: C.textSoft, fontSize: TYPE_SCALE[10.5], cursor: 'pointer', textDecoration: 'underline' },
            }, "Who can do what here?")
            : React.createElement(React.Fragment, null,
                React.createElement("span", { style: { color: C.gold, fontWeight: 600 } }, isOwner ? "As the guild owner, you " : "The guild owner "),
                "creates the anthology, reviews submissions, proposes the revenue split, and publishes or cancels it. ",
                React.createElement("span", { style: { color: C.gold, fontWeight: 600 } }, "Every member "),
                "may submit one manuscript while it's open, edit or withdraw their own pending submission, and approve only their own revenue share \u2014 nobody, including the owner, can change a share once a contributor has approved it without resetting every approval first."));
}


// ---------- Guild Anthologies — "The Workshop" ----------
// The full anthology experience (landing page, workspace, and — as of this update — the
// Founder-Guild/signed-out/offline simulated preview too) no longer lives here — see
// guild-anthology.jsx's GuildAnthologyScreen, which the 'anthology' case in this file's own tab
// switch renders directly and which now routes to either GuildAnthologyWorkshop (real) or
// GuildAnthologyWorkshopSimulated (preview) itself. What stays in THIS file is only what both of
// those still reuse: GoAnthologyOverviewSimulated (the simulated Overview tab's content —
// submissions/split, no banner of its own), GW_ANTHOLOGY_STYLES (the shared "pinned manuscript
// pages on a corkboard" visual language every version renders with), GoCoverPicker, and
// GoAnthologyPermissionsNote. A shared writing desk, not a storefront:
// submissions read as manuscript pages pinned to the workshop wall (a slight alternating tilt +
// a corkboard pin, not a rounded SaaS card), and the anthology itself opens onto a desk plate
// rather than a plain title block. Mobile-first: the pinned-manuscript list is a single column
// by default (a phone doesn't have room for a corkboard grid), gaining a two-column spread only
// once there's room to actually see two pages side by side.
export const GW_ANTHOLOGY_STYLES = `
    .gw-desk-banner{position:relative;border-radius:${RADIUS_SCALE[14]}px;border:1px solid rgba(200,155,60,0.28);background:linear-gradient(160deg,#241E14,${C.surfaceAlt} 70%);padding:20px 18px;margin-bottom:20px;text-align:center;overflow:hidden;}
    .gw-desk-banner::before{content:'';position:absolute;left:0;right:0;bottom:0;height:6px;background:linear-gradient(90deg,transparent,rgba(200,155,60,0.35),transparent);}
    .gw-quill{font-size:22px;display:block;margin-bottom:8px;transform:rotate(-12deg);}
    .gw-eyebrow{font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:${C.gold};margin-bottom:6px;}
    .gw-title{font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:18px;color:${C.text};margin-bottom:6px;}
    .gw-sub{font-size:12px;color:${C.textSoft};line-height:1.55;max-width:340px;margin:0 auto;}
    .gw-pin-list{display:grid;grid-template-columns:1fr;gap:14px;}
    @media (min-width: 620px) { .gw-pin-list{grid-template-columns:1fr 1fr;} }
    .gw-page{position:relative;display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:linear-gradient(175deg,#232025,#1C1A1E);border:1px solid #2E2A28;border-left:3px solid rgba(200,155,60,0.4);border-radius:3px 10px 10px 3px;padding:15px 16px 15px 14px;cursor:pointer;box-shadow:0 6px 14px rgba(0,0,0,0.35);}
    .gw-page::before{content:'\\1F4CC';position:absolute;top:-9px;left:18px;font-size:13px;filter:drop-shadow(0 2px 2px rgba(0,0,0,0.5));}
    .gw-desk-plate{border-radius:${RADIUS_SCALE[14]}px;background:linear-gradient(160deg,#211D18,#19160F);border:1px solid rgba(200,155,60,0.24);padding:20px 18px;margin-bottom:18px;text-align:center;}
    .gw-slip{position:relative;padding:12px 14px 12px 16px;border-left:2px dashed rgba(138,134,128,0.35);background:#1D1B1D;border-radius:0 8px 8px 0;margin-bottom:8px;}
`;
