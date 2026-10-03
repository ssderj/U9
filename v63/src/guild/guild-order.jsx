import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect, useMemo } from 'react';
import { storage } from '../lib/storage.js';
import { GuildQuestBoard } from './guild-hall.jsx';
import { TYPE_SCALE } from '../shell/nav-context.jsx';
import { GoGuildEventsSection } from './guild-events-section.jsx';
// The redesigned Guild Anthology landing page + workspace (list of anthologies, Start an
// Anthology, and a tabbed Overview/Manuscript/World Bible workspace per anthology) \u2014 built
// entirely on the anthology backend calls imported above, plus GoManuscriptTab/GoWorldBibleTab
// below, reused rather than reinvented. See guild-anthology.jsx's own header for the full picture.
import { GuildAnthologyScreen } from './guild-anthology.jsx';
import { GO_ROLES, GO_TABS, GoRoleBadge, GoTabNav, goBuildAnthologySeed, goBuildRoster, goPlayerRung } from './guild-order-core.jsx';
import { GoRosterTab, useGoRealRoster } from './guild-order-roster.jsx';
import { GoTreasuryTab } from './guild-order-treasury.jsx';
import { GoCouncilTab } from './guild-order-council.jsx';

// ---------- The Guild Order ----------
// A prestigious creative-organization layer on top of the existing Guild Hall: roles, a shared
// manuscript, a shared World Bible, a seasonal anthology, workshops, the same real Guild Quests
// board, a calendar, a treasury, a library, Council voting, and a monthly competition.
//
// HONESTY NOTE (same policy as the Living Universe screen): this note used to say Inkroot had no
// backend at all for the Guild Order, so every OTHER member was a simulated presence. That's no
// longer true for any tab:
//   - Roster is real — every OTHER member shown is a real writer, fetched from
//     founder_guild_members or player_guild_members (whichever backs this guild type), with a
//     real role/rung: a Player Guild's owner/treasurer/officer roles are already RLS-authoritative
//     (see 44_migration_guild_treasury_roles_and_approvals.sql); a Founder Guild member's rung is
//     derived from the same public Reputation signal AuthorsHallScreen already uses for someone
//     else's Hall (their quality-length published book count — see goRealFounderRung below).
//   - Manuscript is real — chapters and passages genuinely written and saved by real guild
//     members via guild_order_chapters/guild_order_passages (migration 65), not this device's own
//     local `storage` — and live (migration 66, Realtime Postgres Changes, same mechanism the
//     Fireside already uses — see subscribeGuildManuscriptRealtime in lib/guild-manuscript.js).
//   - World Bible is real too (migration 81) — same shape as Manuscript: real entries via
//     guild_order_world_entries, live (subscribeGuildWorldBibleRealtime in
//     lib/guild-world-bible.js), one row per entry rather than a chapters/passages split since an
//     entry has no separate multi-contributor document to protect (see the migration's own header).
//   - Treasury and Anthology are real too (migration 69, "Founder Guild parity") — for BOTH guild
//     types now, not just a Player Guild the way this note used to say: GoTreasuryTabReal/the real
//     GuildAnthologyScreen render whenever remoteGuildId is set, which migration 69 made true for a
//     Founder Guild as well (its own fixed backendGuildId — see FOUNDER_GUILDS in guild-hall.jsx).
//   - Council is real too (migration 82) — real proposals and real one-vote-per-member tallies via
//     guild_order_proposals/guild_order_votes, live (subscribeGuildCouncilRealtime in
//     lib/guild-order-council.js), same document/contribution split as Manuscript for the same
//     reason (a vote is a contribution to a proposal, not its own guild-scoped document).
// None of these six are split real-for-Player/simulated-for-Founder anymore — every one of them
// is real for both guild types, with no simulated fallback EXCEPT for a genuinely signed-out or
// offline session (see each tab's own GoXTabSimulated/GuildAnthologyWorkshopSimulated for that
// one remaining honest fallback role — Council has none, since GoCouncilTab has always rendered
// the same real-fetch component regardless of session state, same as Roster) — a
// real-but-possibly-empty state (open the tab as the first real member, see mostly just yourself)
// is the honest choice there rather than papering over emptiness with a rich fake one; see
// fetchGuildManuscript's own comment in lib/guild-manuscript.js and goBuildRoster below for the
// fuller rationale. The Guild Quests tab doesn't duplicate anything; it just renders the real
// GuildQuestBoard defined in guild-hall.jsx.
//
// goBuildRoster below now only feeds Anthology's own seed helper (goBuildAnthologySeed), which the
// signed-out/offline simulated preview uses — the real tabs no longer read from it at all. (The
// header's old simulated "pulse line" was removed rather than dressed up as real activity. The old GO_ACTIVE_PROPOSAL/
// GO_HISTORICAL_PROPOSALS/GO_WORLD_SEED placeholder data has been removed.)

const GO_STATE_KEY_PREFIX = 'inkroot:guildOrder:v1:';


function goDefaultState() {
    return {
        worldEntries: [], anthologySubmissions: [],
        treasurySpent: 0, treasuryLedger: [],
        councilVote: null, proposals: [],
    };
}


function useGoState(guildKey) {
    const [state, setState] = useState(null);
    const key = GO_STATE_KEY_PREFIX + (guildKey || 'guild');
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let loaded = null;
            try { const res = await storage.get(key); if (res && res.value) loaded = JSON.parse(res.value); } catch (e) { /* nothing stored yet */ }
            if (!cancelled) setState({ ...goDefaultState(), ...(loaded || {}) });
        })();
        return () => { cancelled = true; };
    }, [key]);
    const patchState = (patch) => {
        setState((prev) => {
            const next = { ...prev, ...patch };
            storage.set(key, JSON.stringify(next)).catch(() => { });
            return next;
        });
    };
    return [state, patchState];
}


export function GuildOrderScreen({
    guild, guildKey, isFounderView, guildRank, guildReputation, writerProfile, writerRank, projects, lifetimeStats, remoteGuildId, isOwner, onViewPublishedBook, initialTab,
    initialAnthologyId, initialAnthologyAction, initialAnthologySeedProjectId, initialEventAction,
}) {
    // initialTab lets a caller (e.g. the Guild Order overview directory on the Guild Hall home
    // screen — see guild-order-overview.jsx) land straight on a specific tab instead of always
    // opening to Roster. Purely a starting point for this component's own tab state below, same
    // pattern as GrandLibraryScreen's initialBookId; nothing else about the Guild Order changes.
    const [tab, setTab] = useState((initialTab && GO_TABS.some((t) => t.key === initialTab)) ? initialTab : 'roster');
    const [state, patchState] = useGoState(guildKey);
    const playerName = (writerProfile && (writerProfile.penName || writerProfile.name)) || 'You';
    const playerRung = goPlayerRung(writerRank, isFounderView);
    const roster = useMemo(() => goBuildRoster(guildKey, guild.name, playerName, playerRung), [guildKey, guild.name, playerName, playerRung]);
    // The Guild Order's real id for THIS guild — a Founder Guild's fixed key or a Player Guild's
    // real uuid — is whichever of guildKey/remoteGuildId actually applies; used by both the real
    // roster hook and the real manuscript tab below, not by anthologySeed, which stays
    // reading from the simulated `roster` above (see this file's own HONESTY NOTE).
    const realGuildId = isFounderView ? guildKey : remoteGuildId;
    const realRoster = useGoRealRoster({ isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung });
    const anthologySeed = useMemo(() => goBuildAnthologySeed(roster), [roster]);
    // Founder Guild: the rung-based role, as before. Player Guild: the viewer's real stored role
    // (leader / treasurer / officer / member) once the roster has loaded, so a joined member no longer
    // reads as Guild Master; until then the only thing known for sure is whether they own the guild.
    const selfMember = !isFounderView && realRoster.members.find((m) => m.isPlayer);
    const playerRoleKey = isFounderView
        ? (GO_ROLES.find((r) => r.rung === playerRung) || GO_ROLES[GO_ROLES.length - 1]).key
        : (selfMember
            ? ({ leader: 'guildmaster', treasurer: 'treasurer', officer: 'officer' }[selfMember.memberRole] || 'writer')
            : (isOwner ? 'guildmaster' : 'writer'));
    if (!state) {
        return React.createElement("div", { style: S.loadingBlock }, "Opening the Guild Order\u2026");
    }
    return React.createElement("div", { className: "ink-page-in" },
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 22 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], letterSpacing: '0.18em', textTransform: 'uppercase', color: C.textMuted, marginBottom: 10 } }, "The Guild Order"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[24], fontWeight: 600, color: C.text, marginBottom: 10 } }, guild.name),
            React.createElement(GoRoleBadge, { role: playerRoleKey, size: 12 })),
        React.createElement(GoTabNav, { active: tab, onSelect: setTab }),
        React.createElement("div", { role: "tabpanel", id: "go-panel", "aria-labelledby": `go-tab-${tab}` }, (() => {
            switch (tab) {
                case 'roster': return React.createElement(GoRosterTab, { roster: realRoster, guildRank, isPlayerGuild: !isFounderView, guildId: remoteGuildId, canManageRoles: !isFounderView && !!isOwner && !!remoteGuildId });
                case 'anthology': return React.createElement(GuildAnthologyScreen, {
                    guild, guildType: isFounderView ? 'founder' : 'player', guildId: realGuildId, playerRung, seedSubs: anthologySeed, state, patchState, projects, playerName, remoteGuildId, isOwner, onViewPublishedBook,
                    // Passed straight through from whatever the Guild Homepage's Anthology preview
                    // asked for (see home-screen.jsx's pendingAnthology* state) \u2014 all optional,
                    // undefined for every other way into this tab, same as initialTab above.
                    initialSelectedId: initialAnthologyId, initialAction: initialAnthologyAction, initialSeedProjectId: initialAnthologySeedProjectId,
                });
                case 'quests': return React.createElement(GuildQuestBoard, { lifetimeStats });
                case 'treasury': return React.createElement(GoTreasuryTab, { guildReputation, playerRung, state, patchState, remoteGuildId, isOwner, isFounderView });
                case 'events': return React.createElement(GoGuildEventsSection, {
                    remoteGuildId, isOwner, isFounderView, guildKey,
                    // Passed straight through from the Guild Homepage's Guild Events preview when
                    // there's no upcoming event and this writer owns the guild (see
                    // home-screen.jsx's pendingEventAction) — same optional pass-through as
                    // initialAnthologyAction just above. Undefined for every other way into this
                    // tab, so it lands on the list exactly as before.
                    initialAction: initialEventAction,
                });
                case 'council': return React.createElement(GoCouncilTab, { guildType: isFounderView ? 'founder' : 'player', guildId: realGuildId, playerRung, playerName });
                default: return null;
            }
        })()));
}
