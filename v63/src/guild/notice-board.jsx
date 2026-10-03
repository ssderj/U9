import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React from 'react';
import { GO_ROLES } from './guild-order-core.jsx';
import { GuildSectionHeader } from './guild-hall-ui.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- The Guild Notice Board (real) ----------
// REPLACES the old NoticeBoard in guild-hall.jsx, which was six seeded/evergreen cards (a
// welcome, a founding-date card, and four permanently-generic filler notices) — nothing a real
// officer ever wrote. This version shows nothing but real fireside_posts rows: real title-less
// messages, real authors, real timestamps, real pins — tagged category = 'announcement' by
// whoever posted them via the Fireside's own composer (see FIRESIDE_CATEGORIES in
// guild-hall.jsx) further down this same Guild Hall screen. No new backend, no new table: this
// is the same fireside_posts/fireside_reactions system FiresideBoard already reads and writes,
// just filtered, permission-checked, and laid out differently for the compact board up top.
//
// "Authorized Guild admins/officers" is enforced here using the guild's real, existing
// permission signals rather than a new one invented for this feature:
//   - Player Guild: player_guilds.owner_id (real Leader) and player_guild_members.role
//     ('treasurer'/'officer'/'member', real, RLS-authoritative — see 44_migration_guild_
//     treasury_roles_and_approvals.sql), mapped onto the same rung scale the Guild Order's
//     Roster tab already uses (goRealPlayerRung — see guild-order.jsx).
//   - Founder Guild: a real Inkroot platform admin (profiles.is_platform_admin) — the only real
//     officer authority a Founder Guild has server-side (is_guild_officer() in
//     69_migration_founder_guild_parity.sql delegates a Founder Guild's officer authority to
//     "any Inkroot admin", not to any per-member role). A Founder Guild member's cosmetic
//     Reputation-based rung (goRealFounderRung) is deliberately NOT used to authorize a post
//     here — that ladder reflects how much someone has published, not any real posting
//     authority, and using it would let a prolific but unofficial member's post masquerade as
//     an official one.
// Nothing here stops any member from tagging their own Fireside post 'announcement' — the RLS
// on fireside_posts doesn't restrict the category column by role (see library-guild.js). This
// board is what actually enforces "official" by only ever displaying the ones whose author
// really does hold officer-or-above authority (rung >= OFFICER_RUNG_THRESHOLD) by the time it
// renders; an unauthorized member's 'announcement'-tagged post still shows up in the Fireside
// itself (correctly, as their own message) but never here.
//
// There's also no separate "title" column on fireside_posts — a real announcement is just a
// body of text, same as any other post. Rather than inventing one (truncating the body into a
// fake headline), a heading is only ever shown when the author naturally wrote one themselves —
// a first line followed by a blank line, the same convention people already use for an email or
// a forum post. Everything else just renders as one plain message. See splitNoticeText below.
// DATA NOTE: the fetch, the officer-authority check and the realtime subscription now live in
// useGuildHallData (guild-hall-data.js), which loads them once for the whole Guild tab (counts, the
// Today strip and the Fireside new dot share the same posts). This file only draws the result. The
// authority rules described above are unchanged; they moved with the fetch.
const HOMEPAGE_NOTICE_LIMIT = 3;


export function splitNoticeText(body) {
    const text = (body || '').trim();
    const blankLineIdx = text.search(/\n\s*\n/);
    if (blankLineIdx === -1)
        return { heading: null, message: text };
    const firstLine = text.slice(0, blankLineIdx).trim();
    const rest = text.slice(blankLineIdx).trim();
    // Only treat it as a real heading if it reads like one — short, and not the whole message.
    if (!firstLine || firstLine.length > 90 || !rest)
        return { heading: null, message: text };
    return { heading: firstLine, message: rest };
}


function formatNoticeDate(iso) {
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    catch (e) {
        return '';
    }
}


function NoticeRow({ notice }) {
    const roleInfo = GO_ROLES.find((r) => r.rung === notice.rung) || GO_ROLES[GO_ROLES.length - 1];
    const { heading, message } = splitNoticeText(notice.body);
    return React.createElement("div", { style: {
            background: C.surface, border: '1px solid #2A2417', borderRadius: RADIUS_SCALE[12], padding: '12px 14px', textAlign: 'left',
        } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[8], marginBottom: 6 } },
            React.createElement("span", { style: {
                    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[9.5], fontWeight: 700,
                    letterSpacing: '0.04em', textTransform: 'uppercase', color: roleInfo.color,
                    border: `1px solid ${roleInfo.color}66`, borderRadius: RADIUS_SCALE[100], padding: '2px 8px',
                } }, roleInfo.icon, ' ', roleInfo.label),
            React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], fontSize: TYPE_SCALE[10.5], color: C.textSoft } },
                notice.pinned && React.createElement(InkIcon, { name: "pin", size: 13, color: C.gold }),
                formatNoticeDate(notice.created_at))),
        heading && React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], fontWeight: 600, color: C.text, marginBottom: 3, lineHeight: 1.3 } }, heading),
        React.createElement("div", { style: {
                fontSize: TYPE_SCALE[12.5], color: C.textBright, lineHeight: 1.5,
                display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            } }, message),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginTop: 6 } }, notice.author_name || 'A guild officer'));
}


// notices: null while loading, otherwise the already-authorised list from useGuildHallData.
// offline: no synced guild to read from. Empty = one quiet line; only the owner gets a button.
export function NoticeBoard({ notices, offline, isOwner, onPostNotice, onSeeFireside }) {
    const shown = notices ? notices.slice(0, HOMEPAGE_NOTICE_LIMIT) : [];
    const remaining = notices ? notices.length - shown.length : 0;
    const quiet = { fontSize: TYPE_SCALE[12.5], color: C.textMuted };
    return React.createElement("div", { style: { marginBottom: 22, textAlign: 'left' } },
        React.createElement(GuildSectionHeader, { title: "Notices", icon: "scroll", count: notices && notices.length > 0 ? notices.length : null }),
        offline
            ? React.createElement("div", { style: quiet }, "Notices appear once this guild is online.")
            : notices === null
                ? React.createElement("div", { style: quiet }, "Reading the board\u2026")
                : shown.length === 0
                    ? React.createElement("div", { style: { ...quiet, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10] } },
                        React.createElement("span", null, "No notices yet."),
                        isOwner && onPostNotice && React.createElement("button", { onClick: onPostNotice, style: {
                                background: 'none', border: `1px solid ${C.borderStrong}`, color: C.gold, borderRadius: RADIUS_SCALE[9],
                                padding: '0 14px', minHeight: 44, fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                            } }, "Post a notice"))
                    : React.createElement("div", { style: S.col8 },
                        shown.map((n) => React.createElement(NoticeRow, { key: n.id, notice: n })),
                        remaining > 0 && React.createElement("button", { onClick: onSeeFireside, style: {
                                background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: '8px 0', minHeight: 44,
                                fontSize: TYPE_SCALE[12], color: C.textMuted, fontFamily: 'inherit',
                            } }, `${remaining} more notice${remaining === 1 ? '' : 's'} in the Fireside \u203A`)));
}
