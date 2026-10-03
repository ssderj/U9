import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect, useRef } from 'react';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { fetchPlayerGuild, fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchProfileNames } from '../lib/profile.js';
import { setGuildTreasuryRole } from '../lib/guild-treasury.js';
import { fetchPublishedBookCountsByAuthors } from '../lib/library.js';
import { REPUTATION_QUALITY_MIN_WORDS } from '../library/author-reputation.jsx';
import { currentUser } from '../lib/supabaseClient.js';
import { StatCard } from '../shared-ui/ui-cards.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, dialogProps, useDialogBehavior } from '../shell/nav-context.jsx';
import { GO_PLAYER_ROLE_EXTRAS, GO_ROLES, goInputStyle, goRealFounderRung, goRealPlayerRung } from './guild-order-core.jsx';

// Real roster for the Roster tab — replaces the simulated goBuildRoster cast entirely for this
// one tab (goBuildRoster/`roster` itself stays in place further down, still driving the still-
// simulated Anthology-seed/pulse-line flavor text, which would misattribute
// fabricated content to real people if it started reading real names instead — see this file's
// own HONESTY NOTE up top). isOwner/remoteGuildId/guildKey/writerRank/playerRung are exactly the
// same props GuildOrderScreen already threads through everywhere else; membersLoading/members are
// this hook's own async state, not derived synchronously the way the simulated roster was.
export function useGoRealRoster({ isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung }) {
    const [state, setState] = useState({ loading: true, members: [] });
    // Bumped by reload() after the leader appoints or removes an officer/treasurer, so the roster
    // re-fetches in place. Only a different guild/viewer blanks the list back to "Gathering the
    // roster..."; a reload keeps the current rows on screen while it re-fetches.
    const [reloadKey, setReloadKey] = useState(0);
    const identityRef = useRef(null);
    useEffect(() => {
        let cancelled = false;
        const identity = [isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung].join('|');
        if (identityRef.current !== identity) {
            identityRef.current = identity;
            setState({ loading: true, members: [] });
        }
        (async () => {
            const guildId = isFounderView ? guildKey : remoteGuildId;
            if (!guildId) {
                if (!cancelled) setState({ loading: false, members: [] });
                return;
            }
            const user = await currentUser();
            const selfId = user && user.id;
            let rows = [];
            try {
                rows = isFounderView ? await fetchFounderGuildMembers(guildId) : await fetchPlayerGuildMembers(guildId);
            }
            catch (e) {
                if (!cancelled) setState((prev) => ({ loading: false, members: prev.members }));
                return;
            }
            // Founder Guild: every other member's rung comes from their quality-length published
            // book count. One batched query for the whole roster instead of one per member.
            let publishedCounts = {};
            if (isFounderView) {
                try { publishedCounts = await fetchPublishedBookCountsByAuthors(rows.filter((m) => m.user_id !== selfId).map((m) => m.user_id), REPUTATION_QUALITY_MIN_WORDS); }
                catch (e) { /* no signal for these members — all treated as Apprentice below */ }
            }
            // Player Guild: rungs come from real roles, not books, so this is display-only — every
            // published book (any length) per other member, same one batched query. If it fails the
            // rows just show without the count.
            let bookCounts = null;
            if (!isFounderView) {
                try { bookCounts = await fetchPublishedBookCountsByAuthors(rows.filter((m) => m.user_id !== selfId).map((m) => m.user_id), 0); }
                catch (e) { /* roster still renders, just without book counts */ }
            }
            // Player Guild: who the real leader is. The owner's own device already knows it is the
            // owner; anyone else looks it up, so the leader shows as Guild Master to every member
            // instead of as a plain member. Best-effort \u2014 if it fails the roster just shows as before.
            let ownerId = isOwner ? selfId : null;
            if (!isFounderView && !isOwner) {
                try { const g = await fetchPlayerGuild(guildId); ownerId = (g && g.owner_id) || null; }
                catch (e) { /* leader row falls back to its stored role */ }
            }
            const withRung = rows.map((m) => {
                const isSelf = m.user_id === selfId;
                const isLeaderRow = !isFounderView && ((isOwner && isSelf) || (!!ownerId && m.user_id === ownerId));
                let rung;
                if (isSelf && isFounderView) {
                    rung = playerRung;
                }
                else if (isFounderView) {
                    rung = goRealFounderRung(publishedCounts[m.user_id] || 0);
                }
                else {
                    rung = goRealPlayerRung(isLeaderRow, m.role);
                }
                const roleKey = (GO_ROLES.find((r) => r.rung === rung) || GO_ROLES[GO_ROLES.length - 1]).key;
                return {
                    id: m.user_id, name: (isSelf ? playerName : m.name) || 'A writer', role: roleKey, rung, isPlayer: isSelf,
                    // Player Guild only: the real stored role ('treasurer' | 'officer' | 'member'), or
                    // 'leader' for the owner's own row. Null for a Founder Guild, which has no such roles.
                    memberRole: isFounderView ? null : (isLeaderRow ? 'leader' : (m.role || 'member')),
                    joinedAt: m.joined_at || null,
                    // Other members only. Founder Guild: the quality-length count their rung is built
                    // from. Player Guild: all their published books. Null when unknown (or for you).
                    publishedCount: isSelf ? null : isFounderView ? (publishedCounts[m.user_id] || 0) : (bookCounts ? (bookCounts[m.user_id] || 0) : null),
                };
            });
            // A Player Guild's owner might not have their own player_guild_members row (see
            // player_guilds' own schema comment) — add them if fetchPlayerGuildMembers didn't
            // already return them, so the owner isn't missing from their own guild's roster.
            if (!isFounderView && isOwner && !withRung.some((m) => m.isPlayer)) {
                withRung.push({ id: selfId, name: playerName || 'You', role: 'guildmaster', rung: 6, isPlayer: true, memberRole: 'leader' });
            }
            // Same idea for a viewer who isn't the owner: if the owner has no member row of their own,
            // add them so the leader isn't missing from the roster.
            if (!isFounderView && !isOwner && ownerId && !withRung.some((m) => m.id === ownerId)) {
                let ownerName = null;
                try { const names = await fetchProfileNames([ownerId]); ownerName = names[ownerId]; }
                catch (e) { /* shows as "A writer" below */ }
                withRung.push({ id: ownerId, name: ownerName || 'A writer', role: 'guildmaster', rung: 6, isPlayer: false, memberRole: 'leader', joinedAt: null, publishedCount: null });
            }
            withRung.sort((a, b) => b.rung - a.rung);
            if (!cancelled) setState({ loading: false, members: withRung });
        })();
        return () => { cancelled = true; };
    }, [isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung, reloadKey]);
    return { ...state, reload: () => setReloadKey((n) => n + 1) };
}


// What each role is, in one line, so the headings explain the hierarchy instead of just naming it.
const ROLE_BLURBS = {
    guildmaster: 'Leads the guild and holds final say.',
    council: 'Votes on proposals and guides the guild.',
    editor: 'Reviews and approves shared work.',
    mentor: 'Guides newer writers.',
    writer: 'Contributes to the shared manuscript and world.',
    apprentice: 'New to the guild, learning the ropes.',
    treasurer: 'Authorizes and approves guild spending.',
    officer: 'Helps run the guild: approves results, chapters and spending.',
};
// A Player Guild's real roles are Leader / Treasurer / Officer / Member (player_guild_members.role),
// not the six Founder Guild rungs, so its roster groups by those. GO_ROLES itself is untouched \u2014
// other screens still use it as before.
const PLAYER_ROLE_GROUPS = [
    GO_ROLES.find((r) => r.key === 'guildmaster'),
    GO_PLAYER_ROLE_EXTRAS.treasurer,
    GO_PLAYER_ROLE_EXTRAS.officer,
    GO_ROLES.find((r) => r.key === 'writer'),
];
function playerGroupKey(m) {
    if (m.memberRole === 'leader') return 'guildmaster';
    if (m.memberRole === 'treasurer') return 'treasurer';
    if (m.memberRole === 'officer') return 'officer';
    return 'writer';
}
const APPOINT_INFO = {
    officer: {
        label: 'Officer',
        powers: 'Can approve event results and manuscript chapters, authorize and approve guild treasury spending, post on the Fireside, and review quiz questions. Because officers can see quiz answer keys, they can\u2019t play their own guild\u2019s quizzes or tournaments.',
    },
    treasurer: {
        label: 'Treasurer',
        powers: 'Can authorize and approve guild treasury spending, approve event results and manuscript chapters, and post on the Fireside. Treasurers can\u2019t review quiz questions.',
    },
};
const sheetBtn = (primary, disabled) => ({
    width: '100%', boxSizing: 'border-box', textAlign: 'left', fontFamily: 'inherit', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
    padding: '11px 14px', borderRadius: RADIUS_SCALE[10], cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
    border: primary ? '1px solid rgba(232,196,104,0.5)' : `1px solid ${C.border}`,
    background: primary ? `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` : C.surface,
    color: primary ? C.goldBright : C.text,
});

// Bottom sheet the Guild Leader gets on tapping another member in a Player Guild's roster. Two steps:
// pick a role, then confirm it with what that role can do. The server (set_guild_treasury_role) is the
// real gate \u2014 it only accepts the guild's actual owner and refuses to touch the leader's own row; this
// sheet just doesn't offer what it would refuse.
function RosterMemberSheet({ member, guildId, onClose, onChanged }) {
    const [pending, setPending] = useState(null); // null | 'officer' | 'treasurer' | 'member'
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const dlgRef = useDialogBehavior(() => { if (!busy) onClose(); });
    const current = member.memberRole === 'officer' || member.memberRole === 'treasurer' ? member.memberRole : 'member';
    const currentLabel = current === 'member' ? 'Member' : APPOINT_INFO[current].label;
    const options = ['officer', 'treasurer'].filter((r) => r !== current).concat(current === 'member' ? [] : ['member']);

    const confirm = async () => {
        setBusy(true); setError(null);
        try {
            await setGuildTreasuryRole(guildId, member.id, pending);
            onChanged();
            onClose();
        }
        catch (e) {
            setError((e && e.message) || 'Couldn\u2019t change that role. Try again.');
            setBusy(false);
        }
    };

    const heading = pending
        ? (pending === 'member' ? `Remove ${member.name}\u2019s ${currentLabel} role?` : `Appoint ${member.name} as ${APPOINT_INFO[pending].label}?`)
        : member.name;
    const body = pending === null
        ? React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, marginBottom: 14 } }, `Current role: ${currentLabel}`),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
                options.map((r) => React.createElement("button", { key: r, type: 'button', onClick: () => { setError(null); setPending(r); }, style: sheetBtn(false, false) },
                    r === 'member' ? `Remove ${currentLabel} role` : `${current === 'member' ? 'Make' : 'Change to'} ${APPOINT_INFO[r].label}`))))
        : React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, lineHeight: 1.55, marginBottom: 14 } },
                pending === 'member'
                    ? `${member.name} goes back to being a regular member and loses the abilities that came with the role.`
                    : APPOINT_INFO[pending].powers),
            error && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
                React.createElement("button", { type: 'button', disabled: busy, onClick: confirm, style: sheetBtn(true, busy) },
                    busy ? 'Saving\u2026' : (pending === 'member' ? 'Remove role' : `Appoint as ${APPOINT_INFO[pending].label}`)),
                React.createElement("button", { type: 'button', disabled: busy, onClick: () => { setError(null); setPending(null); }, style: sheetBtn(false, busy) }, 'Back')));

    return React.createElement("div", {
        ref: dlgRef, ...dialogProps(`Manage ${member.name}`), onClick: () => { if (!busy) onClose(); },
        style: { position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
    },
        React.createElement("div", {
            onClick: (e) => e.stopPropagation(),
            style: {
                width: '100%', maxWidth: 480, boxSizing: 'border-box', background: `linear-gradient(160deg, #241F16, ${C.surfaceInk})`,
                border: `1px solid ${C.borderStrong}`, borderBottom: 'none', borderRadius: `${RADIUS_SCALE[16]}px ${RADIUS_SCALE[16]}px 0 0`,
                padding: '20px 20px calc(20px + env(safe-area-inset-bottom, 0px))', boxShadow: '0 -12px 40px rgba(0,0,0,0.5)',
            },
        },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: C.text } }, heading),
                React.createElement("button", { type: 'button', "aria-label": 'Close', disabled: busy, onClick: onClose, style: { background: 'none', border: 'none', color: C.textSoft, fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1 } }, "\u2715")),
            body));
}
// Past this many members, the lower role groups start collapsed and a search box appears.
const BIG_ROSTER = 12;

function rosterInitials(name) {
    const letters = String(name || '').split(/\s+/).filter(Boolean).map((n) => Array.from(n)[0]).join('');
    return (Array.from(letters).slice(0, 2).join('') || '?').toUpperCase();
}

function rosterJoined(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); } catch (e) { return ''; }
}

// isPlayerGuild switches the grouping to real Player Guild roles; canManageRoles (the Leader of a Player
// Guild, with guildId set) makes other members' rows tappable to open the appoint sheet. Both default
// off, so a caller that passes neither gets the roster exactly as before.
export function GoRosterTab({ roster, guildRank, isPlayerGuild = false, guildId = null, canManageRoles = false }) {
    const { loading, members, reload } = roster;
    const [selected, setSelected] = useState(null);
    const manage = canManageRoles && !!guildId;
    const [query, setQuery] = useState('');
    const [openGroups, setOpenGroups] = useState({});
    const big = members.length > BIG_ROSTER;
    const q = query.trim().toLowerCase();
    const searching = q.length > 0;
    const visibleMembers = searching ? members.filter((m) => m.name.toLowerCase().includes(q)) : members;
    const groupKeyOf = isPlayerGuild ? playerGroupKey : (m) => m.role;
    const grouped = (isPlayerGuild ? PLAYER_ROLE_GROUPS : GO_ROLES).map((role) => ({ role, members: visibleMembers.filter((m) => groupKeyOf(m) === role.key) })).filter((g) => g.members.length > 0);
    // In a big guild the Writer and Apprentice groups start folded; searching always shows matches.
    const isOpen = (role) => searching || !big || role.rung > 2 || openGroups[role.key] === true;
    const renderGroup = (g) => {
        const role = g.role;
        const roleMembers = g.members;
        const open = isOpen(role);
        const foldable = big && !searching && role.rung <= 2;
        const headerInner = [
            React.createElement("span", { key: 'i', style: { fontSize: TYPE_SCALE[15] } }, role.icon),
            React.createElement("span", { key: 'l', style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: role.color } }, role.label),
            React.createElement("span", { key: 'c', style: S.noteSmall }, `(${roleMembers.length})`),
            foldable && React.createElement("span", { key: 'x', style: { marginLeft: 'auto', fontSize: TYPE_SCALE[11], color: C.textMuted } }, open ? 'Hide' : 'Show'),
        ];
        const headerStyle = { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], width: '100%' };
        const header = React.createElement("div", { style: { marginBottom: 10 } },
            foldable
                ? React.createElement("button", { onClick: () => setOpenGroups((prev) => ({ ...prev, [role.key]: !open })), "aria-expanded": open, style: { ...headerStyle, background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' } }, headerInner)
                : React.createElement("div", { style: headerStyle }, headerInner),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 2 } }, ROLE_BLURBS[role.key]));
        const memberRows = open ? roleMembers.map((m) => {
            const avatar = React.createElement("div", { style: { width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[12], fontWeight: 600, color: role.color, background: C.surfaceDeep, border: `1.5px solid ${role.color}` } }, rosterInitials(m.name));
            const details = [
                rosterJoined(m.joinedAt) && `Joined ${rosterJoined(m.joinedAt)}`,
                m.publishedCount != null && `${m.publishedCount} published book${m.publishedCount === 1 ? '' : 's'}`,
            ].filter(Boolean).join(' \u00b7 ');
            const nameLine = React.createElement("div", { style: S.fill },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.text, fontWeight: m.isPlayer ? 600 : 400 } }, m.isPlayer ? `${m.name} (you)` : m.name),
                details && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 2 } }, details));
            const rowStyle = {
                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '9px 12px', borderRadius: RADIUS_SCALE[9],
                background: m.isPlayer ? `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` : C.surface,
                border: `1px solid ${m.isPlayer ? 'rgba(232,196,104,0.4)' : C.border}`,
            };
            if (manage && !m.isPlayer) {
                return React.createElement("button", {
                    key: m.id, type: 'button', onClick: () => setSelected(m), "aria-label": `Manage ${m.name}`,
                    style: { ...rowStyle, width: '100%', boxSizing: 'border-box', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' },
                }, avatar, nameLine, React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, flexShrink: 0 } }, 'Manage \u203a'));
            }
            return React.createElement("div", { key: m.id, style: rowStyle }, avatar, nameLine);
        }) : null;
        return React.createElement("div", { key: role.key, style: { marginBottom: 22 } },
            header,
            memberRows && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } }, memberRows));
    };
    return React.createElement("div", null,
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: SPACE_SCALE[10], marginBottom: 26 } },
            React.createElement(StatCard, { label: 'Members', value: members.length }),
            React.createElement(StatCard, { label: 'Standing', value: guildRank.name, accent: true })),
        manage && members.length > 1 && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, fontStyle: 'italic', marginBottom: 16 } }, "Tap a member to appoint them as an Officer or Treasurer."),
        big && React.createElement("input", { type: 'search', value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search members', "aria-label": 'Search members', style: { ...goInputStyle, marginBottom: 20 } }),
        loading && React.createElement("div", { style: S.emptyBlock }, "Gathering the roster\u2026"),
        !loading && members.length === 0 && React.createElement("div", { style: S.emptyBlock }, "Nobody's shown up here yet \u2014 you're the first."),
        !loading && searching && grouped.length === 0 && React.createElement("div", { style: S.emptyBlock }, "No members match that search."),
        grouped.map(renderGroup),
        selected && React.createElement(RosterMemberSheet, { member: selected, guildId, onClose: () => setSelected(null), onChanged: () => { if (reload) reload(); } }));
}
