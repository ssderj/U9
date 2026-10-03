import { S } from './guild-styles.js';
import { buttonProps } from './guild-a11y.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect } from 'react';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { FounderGuildCrest, GuildBuildingArtStyles, GuildBuildingScene, GuildMoodCaption } from './guild-building-art.jsx';

import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ArchiveDivider, ArchiveSectionHeading } from '../shared-ui/ui-cards.jsx';
import { ConfirmDialog } from '../shared-ui/ui-primitives.jsx';
import { IconPlus } from '../shared-ui/icons.jsx';
import { InkIcon, withIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, dialogProps, useDialogBehavior } from '../shell/nav-context.jsx';


// REMOVED — GuildLevelPanel, the Guild Level Up ceremony (GuildLevelUpOverlay,
// GuildConstructionSequence, GUILD_LEVEL_UP_DURATION_MS/_SEEN_KEY, readSeenGuildLevel/
// writeSeenGuildLevel) and GUILD_LEVEL_REWARDS' level-gated cosmetic unlocks. Guild Level/XP
// no longer exists — see guild-progression.jsx. Guild standing is Guild Reputation only now,
// shown by GuildReputationPanel (guild-reputation-panel.jsx), same as Writer Rank/Reputation
// replaced Writer Level.


// A single engraved plaque used by both the Writer Identity Card and the Guild Banner — one stat,
// given the same quiet carved-medallion treatment as everything else in the writer's chamber
// (RankCrest, AchievementMedal).
export function IdentityPlaque({ icon, label, value, valueColor, caption }) {
    return React.createElement("div", { style: { flex: '1 1 0', minWidth: 0, textAlign: 'center', padding: '0 6px' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[17], marginBottom: 5, opacity: 0.92, display: 'flex', justifyContent: 'center', color: C.gold } },
            typeof icon === 'string' && /^[a-zA-Z]+$/.test(icon) ? React.createElement(InkIcon, { name: icon, size: 18 }) : icon),
        React.createElement("div", {
            style: {
                fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600,
                color: valueColor || C.goldBright, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
        }, value),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: C.textSoft, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 3 } }, label),
        caption && React.createElement("div", { style: { fontSize: TYPE_SCALE[9], color: C.textMuted, fontStyle: 'italic', marginTop: 2 } }, caption));
}


// ---------- Founder Guilds ----------
// The ten permanent, official guilds Inkroot itself stands up so no writer ever faces an empty
// Guild Hall. They can never be deleted and always exist — every new writer must take a seat in
// one before they're able to found a Guild of their own. Each is led by the Founder of Inkroot;
// there is no per-guild leader roster yet since Founder Guilds (unlike Player Guilds) have no
// real guild_members table backing them.
// backendGuildId is this Founder Guild's real row in player_guilds (see
// supabase/history/69_migration_founder_guild_parity.sql) — pass it wherever a Player Guild
// would pass its guild.id: guild-treasury.js, guild-anthologies.js, guild-events.js. Founder
// Guild membership/roster is still read from founder_guild_members by the text id below, not
// from this uuid — the two are bridged server-side by is_guild_member()/is_guild_officer().
export const FOUNDER_GUILDS = [
    { id: 'fantasy', backendGuildId: '00000000-f01d-4000-8000-000000000001', icon: React.createElement(InkIcon, { name: 'castle', size: 22 }), name: 'The Fantasy Guild', motto: 'Where dragons rise and kingdoms are born.' },
    { id: 'romance', backendGuildId: '00000000-f01d-4000-8000-000000000002', icon: React.createElement(InkIcon, { name: 'heart', size: 22 }), name: 'The Romance Guild', motto: 'Every heart has a story worth telling.' },
    { id: 'scifi', backendGuildId: '00000000-f01d-4000-8000-000000000003', icon: React.createElement(InkIcon, { name: 'rocket', size: 22 }), name: 'The Science Fiction Guild', motto: 'Chart the unknown, one page at a time.' },
    { id: 'historical', backendGuildId: '00000000-f01d-4000-8000-000000000004', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 22 }), name: 'The Historical Guild', motto: 'The past deserves an eloquent witness.' },
    { id: 'horror', backendGuildId: '00000000-f01d-4000-8000-000000000005', icon: React.createElement(InkIcon, { name: 'ghost', size: 22 }), name: 'The Horror Guild', motto: 'Fear is just another kind of honesty.' },
    { id: 'mystery', backendGuildId: '00000000-f01d-4000-8000-000000000006', icon: React.createElement(InkIcon, { name: 'search', size: 22 }), name: 'The Mystery Guild', motto: 'Every clue leads somewhere.' },
    { id: 'comedy', backendGuildId: '00000000-f01d-4000-8000-000000000007', icon: React.createElement(InkIcon, { name: 'mask', size: 22 }), name: 'The Comedy Guild', motto: 'Laughter is the plot twist we all need.' },
    { id: 'worldbuilders', backendGuildId: '00000000-f01d-4000-8000-000000000008', icon: React.createElement(InkIcon, { name: 'globe', size: 22 }), name: 'The Worldbuilders Guild', motto: 'Maps, myths, and the bones of new worlds.' },
    { id: 'poetry', backendGuildId: '00000000-f01d-4000-8000-000000000009', icon: React.createElement(InkIcon, { name: 'scroll', size: 22 }), name: 'The Poetry Guild', motto: 'Say more with less.' },
    { id: 'general', backendGuildId: '00000000-f01d-4000-8000-00000000000a', icon: React.createElement(InkIcon, { name: 'chat', size: 22 }), name: 'The General Writers Guild', motto: 'For stories that defy a single shelf.' },
];


const FOUNDER_GUILD_LEADER = 'Founder of Inkroot';


export function founderGuildById(id) {
    return FOUNDER_GUILDS.find((g) => g.id === id) || null;
}


// A writer belongs to only one Guild at a time. Leaving one — Founder or Player — starts this
// cooldown before another can be joined (including re-entering a Player Guild they'd already
// founded). Joining a Founder Guild itself is always free.
const GUILD_LEAVE_COOLDOWN_MINUTES = 2;


const GUILD_LEAVE_COOLDOWN_MS = GUILD_LEAVE_COOLDOWN_MINUTES * 60 * 1000;


export function freshGuildMembership() {
    return { guildType: null, founderGuildId: null, founderJoinedDate: null, playerGuild: null, joinedGuild: null, leftAt: null };
}


export function guildCooldownRemainingMs(membership) {
    if (!membership || !membership.leftAt)
        return 0;
    const elapsed = Date.now() - new Date(membership.leftAt).getTime();
    return Math.max(0, GUILD_LEAVE_COOLDOWN_MS - elapsed);
}


export function formatCooldownRemaining(ms) {
    const totalMinutes = Math.ceil(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0)
        return `About ${hours}h ${minutes}m remain.`;
    return `About ${minutes}m remain.`;
}


// Migrates whatever's stored under GUILD_KEY into the current { guildType, founderGuildId,
// founderJoinedDate, playerGuild, leftAt } shape. Two older shapes are handled: the very first
// Founder-Guild save (which let a writer sit in a Founder Guild and a Player Guild at once, with
// no leftAt/cooldown), and the original pre-Founder-Guild save (a single self-founded guild profile
// directly at the top level). Either way, migration never assumes a writer is currently "in" a
// guild — guildType only ever comes from an explicit, current-shape membership.
export function normalizeGuildMembership(parsed) {
    if (parsed && typeof parsed === 'object' && 'guildType' in parsed) {
        return {
            guildType: parsed.guildType || null,
            founderGuildId: parsed.founderGuildId || null,
            founderJoinedDate: parsed.founderJoinedDate || null,
            playerGuild: parsed.playerGuild || null,
            joinedGuild: parsed.joinedGuild || null,
            leftAt: parsed.leftAt || null,
        };
    }
    if (parsed && typeof parsed === 'object' && ('founderGuildId' in parsed || 'playerGuild' in parsed)) {
        return {
            guildType: parsed.founderGuildId ? 'founder' : null,
            founderGuildId: parsed.founderGuildId || null,
            founderJoinedDate: parsed.founderJoinedDate || null,
            playerGuild: parsed.playerGuild || null,
            joinedGuild: null,
            leftAt: null,
        };
    }
    const wasCustomized = !!(parsed && (parsed.name || parsed.crest || parsed.motto));
    return {
        guildType: null,
        founderGuildId: null,
        founderJoinedDate: null,
        playerGuild: wasCustomized ? {
            name: parsed.name || '', crest: parsed.crest || null, motto: parsed.motto || '',
            createdDate: parsed.createdDate || new Date().toISOString(),
        } : null,
        joinedGuild: null,
        leftAt: null,
    };
}


// The very first thing a writer sees on opening the Guild Hall, before they've taken a seat
// anywhere — a welcome, and a choice of the ten permanent Founder Guilds. There is no "skip":
// every writer settles into an established Guild before they're able to found one of their own.
function JoinGuildByCode({ onJoinByCode, joinCodeError }) {
    const [code, setCode] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        if (!code.trim() || submitting)
            return;
        setSubmitting(true);
        await onJoinByCode(code.trim());
        setSubmitting(false);
    };
    return React.createElement("div", { style: { margin: '18px auto 0', maxWidth: 320 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginBottom: 8, fontStyle: 'italic' } }, "Have an invite code for a friend's guild?"),
        React.createElement("div", { style: S.row8 },
            React.createElement("input", {
                value: code, onChange: (e) => setCode(e.target.value), placeholder: "Invite code",
                onKeyDown: (e) => { if (e.key === 'Enter')
                    handleSubmit(); },
                style: {
                    flex: 1, borderRadius: RADIUS_SCALE[9], border: `1px solid ${C.border}`, background: C.surfaceMuted, color: C.text,
                    padding: '9px 12px', fontSize: TYPE_SCALE[12.5], textAlign: 'center', letterSpacing: '0.04em', fontFamily: 'inherit',
                },
            }),
            React.createElement("button", {
                onClick: handleSubmit, disabled: submitting || !code.trim(), style: {
                    background: 'none', border: `1px solid ${C.borderStrong}`, color: C.gold, borderRadius: RADIUS_SCALE[9],
                    padding: '0 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting || !code.trim() ? 0.6 : 1,
                },
            }, submitting ? "Joining\u2026" : "Join")),
        joinCodeError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginTop: 6 } }, joinCodeError),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: C.textMuted, marginTop: 6, fontStyle: 'italic' } }, "Sign in first \u2014 joining a guild is an account feature."));
}
export function GuildWelcomeScreen({ mode, cooldownLabel, hasPlayerGuild, playerGuildName, onJoin, onEnterOwnGuild, onJoinByCode, joinCodeError }) {
    // Founding a Player Guild for the first time needs a name up front — there is no such thing
    // as an unnamed guild now (see ink-root.jsx's enterOwnGuild, which refuses a first founding
    // with no name too, as the real backstop). Returning to a guild already founded skips this
    // entirely: it already has whatever name it has, and re-entering doesn't touch that.
    const [founding, setFounding] = useState(false);
    const [draftName, setDraftName] = useState('');
    const startFounding = () => { setDraftName(''); setFounding(true); };
    const confirmFounding = () => {
        const cleanName = draftName.trim();
        if (!cleanName) return;
        setFounding(false);
        onEnterOwnGuild(cleanName);
    };
    const headline = mode === 'cooldown'
        ? "Between Guilds"
        : "The Guild Hall";
    const body = mode === 'cooldown'
        ? `You've stepped back from a guild \u2014 a cooldown stands before you can settle into another. ${cooldownLabel || ''}`.trim()
        : mode === 'return'
            ? "You're between guilds. Take a seat in a Founder Guild again, or return to the guild you founded yourself."
            : "Every great storyteller begins their journey within an established Guild. Learn, write, build your reputation, and one day establish a Guild worthy of your own legend.";
    return React.createElement("div", { style: { textAlign: 'center' } },
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: C.gold, opacity: 0.85, marginBottom: 6 } }, "\u2766"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: C.text } }, headline),
            React.createElement("div", {
                style: {
                    fontSize: TYPE_SCALE[13.5], color: '#B8AF95', marginTop: 18, marginBottom: 8, lineHeight: 1.6,
                    maxWidth: 460, marginLeft: 'auto', marginRight: 'auto', fontStyle: 'italic',
                    fontFamily: "'Fraunces', Georgia, serif",
                },
            }, body)),
        (mode === 'return' || mode === 'cooldown') && !(founding && !hasPlayerGuild) && React.createElement("button", {
            onClick: mode === 'cooldown' ? undefined : (hasPlayerGuild ? onEnterOwnGuild : startFounding),
            disabled: mode === 'cooldown',
            style: {
                margin: '10px auto 0', display: 'block', background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceDeep})`, border: `1px solid ${C.borderStrong}`,
                color: mode === 'cooldown' ? C.neutralDim : C.goldBright, borderRadius: RADIUS_SCALE[9], padding: '10px 20px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                cursor: mode === 'cooldown' ? 'default' : 'pointer', opacity: mode === 'cooldown' ? 0.55 : 1,
            },
        }, withIcon('crossedSwords', hasPlayerGuild ? `Return to ${playerGuildName || 'My Guild'}` : "Establish Your Own Guild", 15)),
        (founding && !hasPlayerGuild) && React.createElement("div", { style: { margin: '10px auto 0', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("input", {
                autoFocus: true, value: draftName, placeholder: "Name your guild\u2026",
                onChange: (e) => setDraftName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') confirmFounding(); },
                style: {
                    background: C.surfaceDeep, border: `1px solid ${C.borderStrong}`, borderRadius: RADIUS_SCALE[9],
                    color: C.text, fontSize: TYPE_SCALE[12.5], padding: '9px 12px', textAlign: 'center',
                },
            }),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center' } },
                React.createElement("button", {
                    onClick: () => setFounding(false),
                    style: {
                        background: 'none', border: `1px solid ${C.borderStrong}`, color: C.textSoft, borderRadius: RADIUS_SCALE[9],
                        minHeight: 44, padding: '8px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer',
                    },
                }, "Cancel"),
                React.createElement("button", {
                    onClick: confirmFounding,
                    disabled: !draftName.trim(),
                    style: {
                        background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceDeep})`, border: `1px solid ${C.borderStrong}`,
                        color: draftName.trim() ? C.goldBright : C.neutralDim, borderRadius: RADIUS_SCALE[9],
                        minHeight: 44, padding: '8px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600,
                        cursor: draftName.trim() ? 'pointer' : 'default', opacity: draftName.trim() ? 1 : 0.55,
                    },
                }, "Found Guild")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, fontStyle: 'italic' } }, "A guild needs a name before it can be founded.")),
        mode === 'cooldown' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 8, fontStyle: 'italic' } },
            hasPlayerGuild ? "Unlocks once the cooldown above ends." : "Unlocks once the cooldown above ends \u2014 that includes founding a Guild of your own for the first time, not just rejoining a Founder Guild."),
        mode !== 'cooldown' && React.createElement(JoinGuildByCode, { onJoinByCode, joinCodeError }),
        mode !== 'cooldown' && React.createElement(React.Fragment, null,
            React.createElement(ArchiveDivider, { maxWidth: 320, margin: '26px auto 22px', fontSize: TYPE_SCALE[11], color: C.borderStrong, opacity: 1 }),
            React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "castle", size: 20, style: { display: "inline-block" } }), label: "Founder Guilds" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, marginTop: 8, marginBottom: 22 } }, "Permanent guilds raised by Inkroot itself \u2014 every one led by the ", FOUNDER_GUILD_LEADER, "."),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SPACE_SCALE[16], textAlign: 'left' } },
                FOUNDER_GUILDS.map((fg) => React.createElement("div", {
                    key: fg.id, style: {
                        background: `linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`, border: `1px solid ${C.border}`,
                        borderRadius: RADIUS_SCALE[14], overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    },
                },
                    React.createElement(GuildBuildingScene, { guildId: fg.id, compact: true }),
                    React.createElement("div", { style: { padding: '16px 18px 20px', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
                        React.createElement("div", { style: S.serifTitle }, fg.name),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8390', fontStyle: 'italic', lineHeight: 1.4, minHeight: 30 } }, "\u201C", fg.motto, "\u201D"),
                        React.createElement(GuildMoodCaption, { guildId: fg.id }),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#6C6C74', letterSpacing: '0.03em', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } }, React.createElement(InkIcon, { name: "crown", size: 10 }), "Led by ", FOUNDER_GUILD_LEADER),
                        React.createElement("button", {
                            onClick: () => onJoin(fg.id), style: {
                                marginTop: 4, background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceDeep})`, border: `1px solid ${C.borderStrong}`,
                                color: C.goldBright, borderRadius: RADIUS_SCALE[9], padding: '10px 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                            },
                        }, "Join this Guild"))))),
            React.createElement(GuildBuildingArtStyles, null),
            React.createElement(GuildBenefitsPanel, null)));
}


// A static, non-clickable roster entry representing the Founder of Inkroot — every Founder Guild's
// permanent leader. Deliberately plainer than MemberCard (no avatar upload, no click-through)
// since it isn't a real writer account, just Inkroot's own standing presence in the Hall.
function FounderLeaderCard({ guildName }) {
    return React.createElement("div", {
        className: "member-card", style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start',
            background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceInk})`, border: `1px solid ${C.borderStrong}`,
            borderRadius: RADIUS_SCALE[14], padding: 18, marginBottom: 12,
        },
    },
        React.createElement("div", { style: {
                width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
                background: `radial-gradient(circle at 34% 28%, #3A2F18, ${C.surfaceDeep} 72%)`,
                border: `2px solid ${C.gold}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[22],
            } }, React.createElement(InkIcon, { name: "crown", size: 22 })),
        React.createElement("div", { style: S.fill },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("div", { style: S.serifTitle }, FOUNDER_GUILD_LEADER),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: GUILD_ROLES[0].color, border: `1px solid ${GUILD_ROLES[0].color}55`, borderRadius: RADIUS_SCALE[5], padding: '2px 6px' } }, GUILD_ROLES[0].icon, ' ', GUILD_ROLES[0].name)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8390', marginTop: 5, lineHeight: 1.4 } }, "Presiding permanently over ", guildName || 'this guild', " on behalf of Inkroot.")));
}


// What a writer earns simply by holding a seat in a Founder Guild. None of these are guild-specific
// mechanics yet (they're the same lifetime systems Inkroot already tracks — XP, reputation,
// achievements, streaks), but while inside a Founder Guild they all count toward that guild.
const FOUNDER_GUILD_BENEFITS = [
    { icon: React.createElement(InkIcon, { name: 'medal', size: 17 }), label: 'Guild XP' },
    { icon: React.createElement(InkIcon, { name: 'starFilled', size: 17 }), label: 'Writer XP' },
    { icon: React.createElement(InkIcon, { name: 'hourglass', size: 17 }), label: 'Reputation' },
    { icon: React.createElement(InkIcon, { name: 'tag', size: 17 }), label: 'Guild Titles' },
    { icon: React.createElement(InkIcon, { name: 'trophy', size: 17 }), label: 'Guild Achievements' },
    { icon: React.createElement(InkIcon, { name: 'library', size: 17 }), label: 'Publishing achievements' },
    { icon: React.createElement(InkIcon, { name: 'flame', size: 17 }), label: 'Writing streaks' },
    { icon: React.createElement(InkIcon, { name: 'eye', size: 17 }), label: "Readers' recognition" },
];


function GuildBenefitsPanel() {
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "sparkle", size: 20, style: { display: "inline-block" } }), label: "While Inside This Founder Guild, Writers Earn" }),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: SPACE_SCALE[12], marginTop: 16 } },
            FOUNDER_GUILD_BENEFITS.map((b) => React.createElement("div", {
                key: b.label, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], background: `linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`,
                    border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[11], padding: '12px 14px',
                },
            },
                React.createElement("span", { style: { display: 'inline-flex' } }, b.icon),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: C.textBright, fontWeight: 500 } }, b.label)))));
}


// The large Guild Banner at the top of the Guild Hall — the writers'-fortress counterpart to the
// Writer Identity Card. A Founder Guild's banner (isFounder: true) is read-only — its name, motto,
// and crest are fixed, since it's a permanent Inkroot institution — but a writer can still leave
// their seat in it (leaving always starts the cooldown before joining anywhere else). A writer's
// own Player Guild keeps the original editable banner: they're its sole real member and its only
// possible officer, which is why the Invite button always shows. Guild Level rewards (new banner
// backdrop, animated crest, exclusive theme, golden name) layer on here purely cosmetically once
// earned; Members Online is now a real Presence-backed count passed down from home-screen.jsx
// (see onlineCount below and subscribeGuildPresence in lib/player-guild.js) rather than something
// this component derives itself.
// An empty, stable default so a caller that hasn't wired presence yet (or a signed-out writer,
// per subscribeGuildPresence's own honesty note) gets "nobody online" rather than every member
// rendering with a fresh, identity-changing empty Set on every render.
const NOBODY_ONLINE = new Set();

// Real members of a Player Guild — owned or joined — fetched once per guild id. Kept separate
// from GuildBanner's own "Total Members" plaque (which still just defaults to 1) rather than
// threading a loading member count back up into a preceding sibling component; this renders its
// own compact list right below the banner instead. onlineUserIds is the same Presence Set
// GuildBanner's Members Online plaque counts from (subscribed once, up in home-screen.jsx, and
// passed to both rather than each opening its own channel for the same guild) — each pill gets a
// live green/grey dot exactly like MemberCard's own avatar dot uses.
//
// Shared pill-row rendering lives in GuildMemberPills below — this and FounderGuildRoster differ
// only in which table backs the fetch (player_guild_members vs founder_guild_members), not in
// how the roster itself is drawn.
function GuildMemberPills({ members, onlineUserIds }) {
    const online = onlineUserIds || NOBODY_ONLINE;
    return React.createElement("div", { style: { marginTop: -14, marginBottom: 26, textAlign: 'center' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 } },
            `${members.length} Member${members.length === 1 ? '' : 's'}`),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', justifyContent: 'center' } },
            members.map((m) => React.createElement("span", {
                key: m.user_id, style: {
                    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                    fontSize: TYPE_SCALE[11], color: C.textBright, background: C.surface, border: '1px solid #2A2417',
                    borderRadius: RADIUS_SCALE[999], padding: '4px 10px 4px 8px',
                },
            },
                React.createElement("span", { style: {
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: online.has(m.user_id) ? '#5FBF6E' : C.neutralDim,
                    } }),
                m.name))));
}

export function PlayerGuildRoster({ guildId, onlineUserIds }) {
    const [state, setState] = useState({ loading: true, error: null, members: [] });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, error: null, members: [] });
        fetchPlayerGuildMembers(guildId)
            .then((members) => { if (!cancelled) setState({ loading: false, error: null, members }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, members: [] }); });
        return () => { cancelled = true; };
    }, [guildId]);
    if (state.loading || state.error || state.members.length === 0)
        return null; // quiet by default — MembersHall below already shows the current writer regardless
    return React.createElement(GuildMemberPills, { members: state.members, onlineUserIds });
}

// Founder Guild counterpart to PlayerGuildRoster above — real as of this fix, not simulated:
// founder_guild_members has held every Founder Guild's actual join/leave history since Phase 8
// (see syncFounderGuildMembership/leaveFounderGuildMembership in lib/library-guild.js), but until
// fetchFounderGuildMembers (also library-guild.js) nothing in the UI ever read it back as a
// member list — it existed purely to gate Fireside/Bookshelf RLS. This is a different roster
// from Guild Order's own (see guild-order.jsx's own HONESTY NOTE) — that deeper roles/
// manuscript/anthology system is also real for Founder Guilds now (fix-tracker items 15-17), and
// Guild Reputation followed the same fix (see founder_guild_member_stats,
// 88_migration_founder_guild_member_stats.sql) — this component just predates all of that and
// was never a stand-in for any of it, so nothing here needed to change once they landed.
export function FounderGuildRoster({ guildId, onlineUserIds }) {
    const [state, setState] = useState({ loading: true, error: null, members: [] });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, error: null, members: [] });
        fetchFounderGuildMembers(guildId)
            .then((members) => { if (!cancelled) setState({ loading: false, error: null, members }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, members: [] }); });
        return () => { cancelled = true; };
    }, [guildId]);
    if (state.loading || state.error || state.members.length === 0)
        return null; // quiet by default — MembersHall below already shows the current writer regardless
    return React.createElement(GuildMemberPills, { members: state.members, onlineUserIds });
}

// The info sheet behind the banner's ⋯ menu: the permanent explanation of what kind of guild this is
// (what used to be an italic paragraph at the foot of the banner). Same dialog behaviour as ConfirmDialog.
function GuildInfoSheet({ title, lines, onClose }) {
    const dlgRef = useDialogBehavior(onClose);
    return React.createElement("div", { ref: dlgRef, ...dialogProps('About this guild'), className: "ink-modal-backdrop", style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 5000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }, onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
        React.createElement("div", { className: "ink-modal-panel", style: {
                background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12],
                padding: 22, maxWidth: 380, width: '100%', boxShadow: '0 24px 48px rgba(0,0,0,0.5)', textAlign: 'left',
            } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: C.text, marginBottom: 10 } }, title || 'About this guild'),
            lines.map((line, i) => React.createElement("div", { key: i, style: { fontSize: TYPE_SCALE[13], color: '#B9B2A0', lineHeight: 1.6, marginBottom: 10 } }, line)),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 } },
                React.createElement("button", { onClick: onClose, style: {
                        background: C.gold, border: 'none', color: C.surfaceDeep, borderRadius: RADIUS_SCALE[6],
                        padding: '10px 18px', minHeight: 44, fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    } }, "Close"))));
}

// A small pencil shown beside the owner's editable name and motto, so they read as editable.
function EditPencil() {
    return React.createElement("span", { "aria-hidden": "true", style: { flexShrink: 0, fontSize: TYPE_SCALE[12], color: C.gold, opacity: 0.85, marginLeft: 6 } }, "\u270E");
}

function BannerStat({ value, label, dot }) {
    return React.createElement("span", { style: { display: 'inline-flex', alignItems: 'baseline', gap: 5, fontSize: TYPE_SCALE[12], color: C.textSoft, textTransform: 'lowercase' } },
        dot && React.createElement("span", { style: { alignSelf: 'center', display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#5FBF6E' } }),
        React.createElement("b", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: C.gold } }, value),
        label);
}

export function GuildBanner({ guild, fileInputRef, handleCrestFile, crestError, onSaveGuild, onLeave, onInvite, inviteStatus, reputation, isFounder, isJoinedMember, founderIcon, founderGuildId, guildLevel, memberCount, onlineCount }) {
    // onlineCount comes from home-screen.jsx's presence subscription; memberCount from the Guild tab's
    // roster fetch. Both are null until real data arrives, and a null renders as "—", never a guess.
    const online = typeof onlineCount === 'number' ? onlineCount : null;
    const notYet = (v) => v === null || v === undefined;
    const dash = "\u2014";
    // "Leave Guild" is destructive and immediate once confirmed, so it asks first.
    const [confirmingLeave, setConfirmingLeave] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    useEffect(() => {
        if (!menuOpen) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [menuOpen]);
    const [infoOpen, setInfoOpen] = useState(false);
    // A guild is read-only to anyone who doesn't own it: every Founder Guild, and a Player Guild
    // joined by invite code.
    const readOnly = isFounder || isJoinedMember;
    const accentBorder = C.borderStrong;
    const bannerBackground = `radial-gradient(ellipse at 20% 0%, rgba(200,155,60,0.16), transparent 70%), linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`;
    const hexClip = 'polygon(50% 0%, 95% 24%, 95% 74%, 50% 100%, 5% 74%, 5% 24%)';
    const infoLines = isFounder
        ? [`Led by ${FOUNDER_GUILD_LEADER}.`, "A permanent Founder Guild \u2014 official, always open, and never deleted. Leaving starts a cooldown before you can join another \u2014 or found (or return to) a Guild of your own from there."]
        : isJoinedMember
            ? ["You joined this guild \u2014 its founder can edit its name, motto, and crest, and holds the Invite. Leaving starts a cooldown before you can join another."]
            : ["You founded this guild \u2014 as its only officer, you hold the Invite. Leaving starts a cooldown before you can join another."];
    const menuItemStyle = {
        display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
        minHeight: 44, padding: '10px 16px', fontSize: TYPE_SCALE[13], fontFamily: 'inherit',
    };
    return React.createElement("div", {
        style: {
            textAlign: 'left', padding: '14px 14px 12px 16px', borderRadius: RADIUS_SCALE[16], marginBottom: 14, position: 'relative',
            background: bannerBackground, border: `1px solid ${accentBorder}`,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 24px rgba(0,0,0,0.35)',
        },
    },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12] } },
            isFounder
                ? React.createElement("div", { style: { width: 56, flexShrink: 0, filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.5))' } },
                    React.createElement(FounderGuildCrest, { guildId: founderGuildId, size: 56 }))
                : React.createElement("div", { ...(readOnly ? {} : buttonProps(() => fileInputRef.current && fileInputRef.current.click(), 'Change guild crest')), style: {
                        width: 56, height: 56, flexShrink: 0, cursor: readOnly ? 'default' : 'pointer', position: 'relative',
                        clipPath: hexClip,
                        background: guild.crest ? `center/cover url(${guild.crest})` : `radial-gradient(circle at 34% 24%, #2A2620, ${C.surfaceDeep} 72%)`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    } },
                    React.createElement("div", { style: { position: 'absolute', inset: 0, clipPath: hexClip, border: `2px solid ${C.gold}`, pointerEvents: 'none' } }),
                    !guild.crest && React.createElement(InkIcon, { name: "shield", size: 22, color: "#8A8272", style: { opacity: readOnly ? 0.9 : 0.55 } }),
                    !readOnly && React.createElement("span", { style: {
                            position: 'absolute', bottom: 3, right: 3, width: 18, height: 18, borderRadius: '50%',
                            background: C.gold, border: `2px solid ${C.surfaceDeep}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[9], color: C.surfaceDeep,
                        } }, "\u270E")),
            !isFounder && !readOnly && React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", onChange: handleCrestFile, style: { display: 'none' } }),
            React.createElement("div", { style: S.fill },
                readOnly
                    ? React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], fontWeight: 600, color: C.text, lineHeight: 1.25, overflowWrap: 'anywhere' } }, guild.name)
                    : React.createElement("div", { style: { display: 'flex', alignItems: 'center' } },
                        React.createElement("input", { value: guild.name, "aria-label": "Guild name", onChange: (e) => onSaveGuild({ name: e.target.value }), placeholder: "Name your guild\u2026", maxLength: 60, style: {
                                flex: 1, minWidth: 0, background: 'none', border: 'none', borderBottom: `1px dashed ${C.borderStrong}`, outline: 'none', padding: '2px 0',
                                fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], fontWeight: 600, color: C.text,
                            } }),
                        React.createElement(EditPencil, null)),
                readOnly
                    ? (guild.motto && React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[12.5], color: C.parchment, marginTop: 3 } }, guild.motto))
                    : React.createElement("div", { style: { display: 'flex', alignItems: 'center', marginTop: 4 } },
                        React.createElement("input", { value: guild.motto || '', "aria-label": "Guild motto", onChange: (e) => onSaveGuild({ motto: e.target.value }), placeholder: "A motto worth rallying behind\u2026", maxLength: 200, style: {
                                flex: 1, minWidth: 0, background: 'none', border: 'none', borderBottom: `1px dashed ${C.border}`, outline: 'none', padding: '2px 0',
                                fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[12.5], color: C.parchment,
                            } }),
                        React.createElement(EditPencil, null))),
            React.createElement("div", { style: { position: 'relative', flexShrink: 0, alignSelf: 'flex-start' } },
                React.createElement("button", { type: "button", "aria-label": "Guild menu", "aria-haspopup": "menu", "aria-expanded": menuOpen, onClick: () => setMenuOpen((o) => !o), style: {
                        width: 44, height: 44, marginTop: -8, marginRight: -6, background: 'none', border: 'none', cursor: 'pointer',
                        color: C.parchment, fontSize: TYPE_SCALE[22], lineHeight: 1,
                    } }, "\u22EF"),
                menuOpen && React.createElement(React.Fragment, null,
                    React.createElement("div", { "aria-hidden": true, onClick: () => setMenuOpen(false), style: { position: 'fixed', inset: 0, zIndex: 40 } }),
                    React.createElement("div", { role: "menu", style: {
                            position: 'absolute', top: 40, right: 0, zIndex: 41, minWidth: 190, overflow: 'hidden',
                            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], boxShadow: '0 12px 28px rgba(0,0,0,0.5)',
                        } },
                        React.createElement("button", { role: "menuitem", onClick: () => { setMenuOpen(false); setInfoOpen(true); }, style: { ...menuItemStyle, color: C.textBright } }, "About this guild"),
                        // Only shown to a Founder Guild member or a Player Guild joined by invite code -
                        // the owner of their own Player Guild has no leave/disband/transfer flow yet (see
                        // leaveCurrentGuild in ink-root.jsx for the matching guard).
                        readOnly && React.createElement("button", { role: "menuitem", onClick: () => { setMenuOpen(false); setConfirmingLeave(true); }, style: { ...menuItemStyle, color: '#E0A0A0', borderTop: '1px solid #2A2A30' } }, "Leave Guild"))))),
        crestError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97757', marginTop: 8 } }, crestError),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 16px', marginTop: 10 } },
            React.createElement(BannerStat, { value: notYet(reputation) ? dash : reputation, label: "reputation" }),
            React.createElement(BannerStat, { value: notYet(memberCount) ? dash : memberCount, label: memberCount === 1 ? 'member' : 'members' }),
            React.createElement(BannerStat, { value: notYet(online) ? dash : online, label: "online", dot: true }),
            !isJoinedMember && React.createElement("button", { onClick: onInvite, style: {
                    marginLeft: 'auto', background: 'linear-gradient(160deg, #201B12, #14110B)', border: `1px solid ${C.borderStrong}`, color: C.gold, borderRadius: RADIUS_SCALE[9],
                    padding: '0 16px', minHeight: 44, fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                } }, "Invite a writer")),
        inviteStatus && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.gold, marginTop: 6 } }, inviteStatus),
        infoOpen && React.createElement(GuildInfoSheet, { title: guild.name || 'About this guild', lines: infoLines, onClose: () => setInfoOpen(false) }),
        confirmingLeave && React.createElement(ConfirmDialog, {
            message: "Are you sure you want to leave this Guild?", confirmLabel: "Leave",
            onCancel: () => setConfirmingLeave(false),
            onConfirm: async () => { setConfirmingLeave(false); await onLeave(); },
        }));
}


// REMOVED — the old NoticeBoard here (six seeded/evergreen parchment notices — a welcome, a
// founding-date card, and four permanently-generic filler notices, none of them anything a real
// officer ever wrote). Replaced by the real, permission-gated one in guild/notice-board.jsx,
// which reads real fireside_posts rows tagged category = 'announcement' by an actual Guild
// Leader/Treasurer/Officer (Player Guild) or Inkroot admin (Founder Guild) — see that file's own
// header for the full picture. The parchment `.notice-board`/`.notice-card`/`.notice-pin` styles are gone;
// notices are plain dark rows now.


// The five Guild Role tiers, for the legend beneath the roster — only Guild Master is ever
// actually held right now (by the founder), but the ladder is shown in full since it's part of
// what the Guild Hall is building toward.
const GUILD_ROLES = [
    { name: 'Guild Master', icon: React.createElement(InkIcon, { name: 'crown', size: 11 }), color: C.goldBright },
    { name: 'Officer', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 11 }), color: C.gold },
    { name: 'Veteran', icon: React.createElement(InkIcon, { name: 'medal', size: 11 }), color: '#A8916A' },
    { name: 'Member', icon: React.createElement(InkIcon, { name: 'book', size: 11 }), color: C.neutralSoft },
    { name: 'Apprentice', icon: React.createElement(InkIcon, { name: 'scroll', size: 11 }), color: '#6C6C74' },
];


// One labeled value inside a Member Card — plainer than IdentityPlaque (no icon, left-aligned,
// built for a 2-column grid rather than a row) since a member card holds more fields in less width.
function MemberStat({ label, value }) {
    return React.createElement("div", { style: { minWidth: 0 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9], color: C.textSoft, letterSpacing: '0.05em', textTransform: 'uppercase' } }, label),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textBright, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value));
}


// A single member's card in the Members' Hall — real data throughout, since Inkroot's only
// possible member (for now) is the writer themself, founder and Guild Master of their own guild.
// Clicking it opens their Author Hall, the same destination as the profile-avatar shortcut
// elsewhere in the app.
export function MemberCard({ profile, rank, role, reputation, currentProject, online, publishedCount, memberSinceLabel, onOpen }) {
    const notYet = (v) => v === null || v === undefined;
    return React.createElement("div", {
        onClick: onOpen, className: "member-card", style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start', cursor: 'pointer',
            background: `linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`, border: `1px solid ${C.border}`,
            borderRadius: RADIUS_SCALE[14], padding: 18,
        },
    },
        React.createElement("div", { style: { position: 'relative', flexShrink: 0 } },
            React.createElement("div", { style: {
                    width: 52, height: 52, borderRadius: '50%',
                    background: profile.avatar ? `center/cover url(${profile.avatar})` : `radial-gradient(circle at 34% 28%, #2A2620, ${C.surfaceDeep} 72%)`,
                    border: `2px solid ${C.gold}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                } }, !profile.avatar && React.createElement(InkIcon, { name: "users", size: 18, color: "#8A8272" })),
            React.createElement("span", { style: {
                    position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%',
                    background: online ? '#5FBF6E' : C.neutralDim, border: `2px solid ${C.surfaceDeep}`,
                } })),
        React.createElement("div", { style: S.fill },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("div", { style: S.serifTitle }, profile.name || 'Unnamed Writer'),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: role.color, border: `1px solid ${role.color}55`, borderRadius: RADIUS_SCALE[5], padding: '2px 6px' } }, role.icon, ' ', role.name)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: rank.color, marginTop: 3 } }, rank.icon, ' ', rank.name),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginTop: 14 } },
                React.createElement(MemberStat, { label: "Reputation", value: notYet(reputation) ? "\u2014" : reputation }),
                React.createElement(MemberStat, { label: "Current Project", value: currentProject || 'Not currently writing' }),
                React.createElement(MemberStat, { label: "Published Books", value: publishedCount }),
                React.createElement(MemberStat, { label: "Member Since", value: memberSinceLabel || "\u2014" }))));
}


// The Members' Hall: the roster of everyone in the guild. This panel itself always shows just the
// current writer — the real, multi-member roster for a Player Guild lives in the separate
// PlayerGuildRoster component, and a Founder Guild's in the sibling FounderGuildRoster (both
// above, both rendered in home-screen.jsx alongside this panel), since MembersHall's own
// single-entry-plus-role-legend layout is shared across both guild types.
function MembersHall({ profile, rank, guild, reputation, currentProject, publishedCount, memberSinceLabel, onOpen, isFounder }) {
    return React.createElement("div", null,
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "columns", size: 20, style: { display: "inline-block" } }), label: "The Members' Hall" }),
        React.createElement("div", { style: { marginTop: 16 } },
            isFounder && React.createElement(FounderLeaderCard, { guildName: guild.name }),
            React.createElement(MemberCard, {
                profile, rank, role: isFounder ? GUILD_ROLES[3] : GUILD_ROLES[0], reputation, currentProject, online: true,
                publishedCount, memberSinceLabel, onOpen,
            })),
        React.createElement(GuildRoleLegend, null));
}


function GuildRoleLegend() {
    return React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8], marginTop: 20, justifyContent: 'center' } },
        GUILD_ROLES.map((r) => React.createElement("span", {
            key: r.name, style: {
                fontSize: TYPE_SCALE[10.5], color: r.color, border: `1px solid ${r.color}40`, borderRadius: RADIUS_SCALE[6], padding: '4px 9px',
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[5],
            },
        }, r.icon, ' ', r.name)));
}




// ---------- Guild Quests ----------
// Five cooperative objectives. Three are wired to real lifetime totals (words, chapters,
// completed/published projects) that Inkroot already tracks — for a guild of one, everything the
// writer writes counts toward them alone until other writers can join. The other two (Recruit,
// Review) have no backing system yet, so their progress is honestly zero rather than invented;
// statKey is null for those, which QuestCard reads as "no system for this yet."
export const GUILD_QUEST_DEFS = [
    { id: 'words2m', icon: React.createElement(InkIcon, { name: 'scroll', size: 18 }), title: 'Write 2,000,000 Words Together', target: 2000000, unit: 'words', guildXP: 5000, reputationReward: 250, statKey: 'totalWords' },
    { id: 'chapters300', icon: React.createElement(InkIcon, { name: 'book', size: 18 }), title: 'Complete 300 Chapters', target: 300, unit: 'chapters', guildXP: 3000, reputationReward: 150, statKey: 'chapters' },
    { id: 'publish25', icon: React.createElement(InkIcon, { name: 'library', size: 18 }), title: 'Publish 25 Books', target: 25, unit: 'books', guildXP: 8000, reputationReward: 400, statKey: 'completedCount' },
    { id: 'recruit15', icon: React.createElement(InkIcon, { name: 'users', size: 18 }), title: 'Recruit 15 New Writers', target: 15, unit: 'writers', guildXP: 4000, reputationReward: 200, statKey: null },
    { id: 'review100', icon: React.createElement(InkIcon, { name: 'search', size: 18 }), title: 'Review 100 Published Stories', target: 100, unit: 'reviews', guildXP: 2500, reputationReward: 120, statKey: null },
];


// REMOVED — GUILD_QUESTS_SEEN_KEY / readQuestsSeenMap / writeQuestSeen tracked which quests had
// already played their completion celebration. QuestCard no longer has one to guard (see above).


// One quest's card: a progress bar, its Reputation reward, and a status pill. Used to also play a
// particle-shatter ceremony plus a sound effect the moment progress first reached target (reusing
// GuildLockShatter and playGuildUnlockSound, both removed along with the rest of the loud
// unlock/level-up machinery — see guild-progression.jsx and guild-reputation-panel.jsx). A
// completed quest still gets a quiet, clearly-visible acknowledgment (the pill turning to
// "Completed"), just not a fanfare.
function QuestCard({ def, progress }) {
    const target = def.target;
    const pct = Math.max(0, Math.min(100, Math.round((progress / target) * 100)));
    const complete = progress >= target;
    const noSystemYet = def.statKey === null;
    return React.createElement("div", {
        style: {
            background: `linear-gradient(160deg, ${C.surfaceWarm}, ${C.surfaceInk})`, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12],
            padding: 16, position: 'relative', textAlign: 'left',
        },
    },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 10 } },
            React.createElement("span", { style: { display: 'inline-flex' } }, def.icon),
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: C.text, flex: 1 } }, def.title),
            React.createElement("span", { style: {
                    fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', borderRadius: RADIUS_SCALE[5], padding: '3px 7px',
                    color: complete ? C.success : C.gold, border: `1px solid ${complete ? '#8FCB8F55' : '#C89B3C55'}`,
                } }, complete ? "\u2713 Completed" : "In Progress")),
        React.createElement("div", { style: { height: 8, borderRadius: RADIUS_SCALE[5], background: C.inputBg, overflow: 'hidden', border: '1px solid #2A2416' } },
            React.createElement("div", { style: { height: '100%', width: `${pct}%`, background: `linear-gradient(90deg, #8A6B25, ${C.goldBright})`, transition: 'width 600ms ease' } })),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginTop: 6 } }, `${progress.toLocaleString()} / ${target.toLocaleString()} ${def.unit}`),
        noSystemYet && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: C.textMuted, fontStyle: 'italic', marginTop: 3 } }, "no system for this yet \u2014 progress starts at zero"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], flexWrap: 'wrap', marginTop: 12, fontSize: TYPE_SCALE[11] } },
            React.createElement("span", { style: { color: '#A8916A' } }, withIcon('hourglass', `+${def.reputationReward} Reputation`, 12))));
}


// The Guild Quests board — cooperative objectives, framed honestly for a guild of one until real
// multi-writer participation exists.
export function GuildQuestBoard({ lifetimeStats }) {
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "crossedSwords", size: 20, style: { display: "inline-block" } }), label: "Guild Quests" }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, textAlign: 'center', marginTop: 6, marginBottom: 18, fontStyle: 'italic' } }, "Cooperative objectives for the whole guild \u2014 for now, everything you write counts toward them alone"),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SPACE_SCALE[14] } },
            GUILD_QUEST_DEFS.map((def) => React.createElement(QuestCard, { key: def.id, def, progress: def.statKey ? (lifetimeStats[def.statKey] || 0) : 0 }))));
}


// ---------- The Fireside ----------
// Inkroot's guild-discussion space — a real, functioning local message board (not a placeholder),
// since posting to it, replying, pinning, and reacting are all things a single writer can
// meaningfully do on their own device without any accounts or networking. Persisted under its own
// key rather than inside guildProfile, since it grows unboundedly while the guild record itself
// stays small.
export const FIRESIDE_KEY = 'inkroot:guild:fireside';


export const FIRESIDE_CATEGORIES = [
    { key: 'discussion', icon: React.createElement(InkIcon, { name: 'chat', size: 15 }), label: 'Guild Discussion' },
    { key: 'advice', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), label: 'Writing Advice' },
    { key: 'worldbuilding', icon: React.createElement(InkIcon, { name: 'map', size: 15 }), label: 'Worldbuilding Ideas' },
    { key: 'feedback', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), label: 'Chapter Feedback' },
    { key: 'announcement', icon: React.createElement(InkIcon, { name: 'horn', size: 15 }), label: 'Announcement' },
];


// Reaction emblems, deliberately not a single "like" — each names a specific kind of appreciation,
// so reacting reads as a considered response rather than a tally.
export const FIRESIDE_REACTIONS = [
    { key: 'fire', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), label: 'Inspired' },
    { key: 'sword', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 15 }), label: 'Well Argued' },
    { key: 'scroll', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), label: 'Noted' },
    { key: 'spark', icon: React.createElement(InkIcon, { name: 'sparkle', size: 15 }), label: 'Brilliant' },
];


// ---------- The Guild Anthology shelf ----------
// A real, wired-up bookshelf for this guild's anthologies — see
// supabase/history/35_migration_guild_anthologies.sql and src/lib/guild-anthologies.js. Every
// row here is a real guild_anthologies record fetched over RLS; nothing here is invented or
// locally simulated. Reuses the exact wooden-shelf markup/CSS (.shelf-stage/.shelf-wood/
// .shelf-bookend/.shelf-scroll/.shelf-item-cover/.shelf-label/.shelf-add-cover/.shelf-add-label,
// all defined once in home-screen.jsx's injected <style>) that the Home dashboard's own "Recent
// Activity" shelf already uses, so an anthology reads as one more row of real books on a real
// shelf rather than a second, differently-dressed list. Player Guilds only (remoteGuildId is
// null for a Founder Guild — see guild-anthologies.js's own header for that scope cut), so this
// renders nothing at all for a Founder Guild rather than showing an empty or fake shelf.
const ANTHOLOGY_STATUS_LABEL = { open: 'Open for submissions', reviewing: 'Reviewing', published: 'Published', cancelled: 'Cancelled' };
const ANTHOLOGY_STATUS_COLOR = { open: '#5FBF6B', reviewing: C.goldBright, published: C.gold, cancelled: '#9C9280' };


export function GuildAnthologyShelf({ remoteGuildId, onOpenPublished, onManage }) {
    // null = not loaded yet (or nothing to load); [] = loaded, genuinely none yet.
    const [anthologies, setAnthologies] = useState(null);
    useEffect(() => {
        setAnthologies(null);
        if (!remoteGuildId)
            return;
        let cancelled = false;
        fetchGuildAnthologies(remoteGuildId)
            .then((rows) => { if (!cancelled) setAnthologies(rows); })
            .catch((e) => { console.warn('Inkroot: guild anthology shelf fetch failed', e); if (!cancelled) setAnthologies([]); });
        return () => { cancelled = true; };
    }, [remoteGuildId]);
    if (!remoteGuildId || anthologies === null)
        return null; // Founder Guild, or still loading — nothing honest to show yet.
    const tiles = anthologies.map((a) => {
        const badge = React.createElement("div", { style: {
                position: 'absolute', top: 6, left: 6, zIndex: 2, fontSize: TYPE_SCALE[8.5], fontWeight: 700,
                letterSpacing: '0.03em', textTransform: 'uppercase', color: C.inputBg,
                background: ANTHOLOGY_STATUS_COLOR[a.status] || '#9C9280', borderRadius: RADIUS_SCALE[100],
                padding: '2px 6px', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            } }, ANTHOLOGY_STATUS_LABEL[a.status] || a.status);
        const coverWrap = React.createElement("div", { className: "shelf-item-cover", style: { borderRadius: RADIUS_SCALE[5] } },
            React.createElement(BookCover, { title: a.title, cover: a.cover, size: 'sm' }),
            badge);
        return React.createElement("div", {
            key: a.id,
            onClick: () => (a.status === 'published' && a.published_book_id) ? onOpenPublished(a.published_book_id) : onManage(),
            className: "proj-row shelf-item", style: {
                cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
                flexShrink: 0, scrollSnapAlign: 'start',
            },
        }, coverWrap, React.createElement("div", { className: "shelf-label", style: { width: 94 } }, a.title));
    });
    const newTile = React.createElement("div", {
        key: "__new_anthology__", onClick: onManage, className: "proj-row shelf-item", style: {
            cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
            flexShrink: 0, scrollSnapAlign: 'start',
        },
    }, React.createElement("div", { className: "shelf-item-cover", style: { borderRadius: RADIUS_SCALE[5] } },
        React.createElement("div", { className: "shelf-add-cover" },
            React.createElement(IconPlus, { width: 17, height: 17 }),
            React.createElement("div", { className: "shelf-add-label" }, "New", React.createElement("br", null), "anthology"))));
    return React.createElement(React.Fragment, null,
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } }), label: "The Guild Anthology" }),
        React.createElement("div", { className: "shelf-stage" },
            React.createElement("div", { className: "shelf-ambient" }),
            React.createElement("div", { className: "shelf-wood" }),
            React.createElement("div", { className: "shelf-bookend shelf-bookend-left" }),
            React.createElement("div", { className: "shelf-bookend shelf-bookend-right" }),
            React.createElement("div", { className: "shelf-scroll" }, ...tiles, newTile)));
}
