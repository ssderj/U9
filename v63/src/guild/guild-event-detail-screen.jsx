import { S } from './guild-styles.js';
import { C, goldA, dangerA } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { fetchGuildEventById, fetchPublicGuildEvents } from '../lib/guild-events.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { currentUser } from '../lib/supabaseClient.js';
import { EventCard } from './guild-event-card.jsx';
import { EventHowItWorks, EventTypeBadge } from './guild-event-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, UniversalBackButton } from '../shell/nav-context.jsx';
import { formatNaira } from '../lib/payments.js';
import { InkIcon, withIcon } from '../shell/ink-icon.jsx';

const GED_PHASE_META = {
    published: { label: 'Upcoming', color: C.sky },
    active: { label: 'Active', color: C.phaseActive },
    completed: { label: 'Completed', color: C.textMuted },
};

function gedFormatDate(ts) {
    return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '\u2014';
}

// Presentation only: a coarse "ends in N days" read-out derived from the end date the page already prints.
// Returns null unless the event is upcoming/active and the end is still ahead, so it never claims anything else.
function gedTimeLeft(endAt, approvalStatus) {
    if (!endAt || !['published', 'active'].includes(approvalStatus)) return null;
    const ms = new Date(endAt).getTime() - Date.now();
    if (Number.isNaN(ms) || ms <= 0) return null;
    const days = Math.ceil(ms / 86400000);
    return days <= 1 ? 'Ends within a day' : `Ends in ${days} days`;
}
export { gedTimeLeft };

// Detail view of a single Guild Event — reached by tapping an event card on Living
// Universe or a guild's public profile. Below the notice it mounts EventCard in `embedded` mode, so a
// player who found the event here can enter and play it without going through the host guild's own
// page (official Inkroot quizzes and tournaments, guild quizzes, tournaments, giveaways, writing and
// world-building events). It is the SAME entry/play logic the guild page uses, not a copy, and the
// server still enforces every eligibility rule (hosting-guild members, question writers, reviewers,
// Inkroot admins on official events, full events); this page only mirrors the refusals as notices. Pulls from the same public, approved-and-published-only
// directory as Living Universe's Guild Events section (fetchPublicGuildEvents — see
// 51_migration_public_guild_events_directory.sql) rather than a second, separate fetch, so this
// page can never show an event a reader couldn't already see on the card that linked here.
export function GuildEventDetailScreen({ eventId, onOpenGuild, isAdmin }) {
    const [event, setEvent] = useState(null); // null while loading, false if not found/not public
    useEffect(() => {
        let cancelled = false;
        setEvent(null);
        if (!eventId) return;
        // No limit: Living Universe can now list every event, so the one tapped may not be in the newest 100.
        fetchPublicGuildEvents().then((rows) => {
            if (cancelled) return;
            setEvent((rows || []).find((r) => r.id === eventId) || false);
        }).catch(() => {
            // A failed fetch used to leave `event` null forever: "Opening the event\u2026" with no way out but Back.
            if (!cancelled) setEvent(false);
        });
        return () => { cancelled = true; };
    }, [eventId]);

    // The full event row, in the shape EventCard and the entry/play panels read (the public listing above is
    // shaped for display only). null = couldn't be read; the notice above still shows and just has no entry block.
    const [fullEvent, setFullEvent] = useState(undefined);
    const [myUserId, setMyUserId] = useState(null);
    const [hostMembers, setHostMembers] = useState([]);
    const loadFullEvent = () => fetchGuildEventById(eventId).then(setFullEvent).catch(() => setFullEvent(null));
    useEffect(() => {
        setFullEvent(undefined);
        if (!eventId) return;
        loadFullEvent();
        currentUser().then((u) => setMyUserId((u && u.id) || null)).catch(() => setMyUserId(null));
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [eventId]);
    // Only a giveaway needs the host guild's roster client-side (to show the "can't enter your own giveaway"
    // notice); add_giveaway_ticket() refuses a hosting-guild member itself either way.
    const needsMembers = !!(event && event.host === 'guild' && event.eventType === 'giveaway');
    const hostGuildId = event ? event.guildId : null;
    useEffect(() => {
        if (!needsMembers || !hostGuildId) { setHostMembers([]); return; }
        let cancelled = false;
        fetchPlayerGuildMembers(hostGuildId).then((m) => { if (!cancelled) setHostMembers(m); }).catch(() => { if (!cancelled) setHostMembers([]); });
        return () => { cancelled = true; };
    }, [needsMembers, hostGuildId]);

    if (event === null) {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: S.loadingBlock }, "Opening the event\u2026"));
    }
    // A cancelled event is no longer in the public listing, but someone who paid an entry fee needs to be able to open it
    // and see why. fetchGuildEventById still returns it (it was public before it was cancelled), so once that read has
    // finished we show a plain cancelled notice instead of "couldn't be found". The refund itself is sent by Inkroot by
    // hand (see refunds-owed-admin.jsx); this page promises nothing beyond what the server recorded.
    if (event === false && fullEvent === undefined) {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: S.loadingBlock }, "Opening the event\u2026"));
    }
    if (event === false && fullEvent && fullEvent.status === 'cancelled') {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: { padding: '28px 20px', border: `1px solid ${dangerA(0.35)}`, borderRadius: RADIUS_SCALE[13], background: C.noticeStub } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: C.danger, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 } }, 'Cancelled'),
                React.createElement("h1", { style: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: TYPE_SCALE[20], margin: '0 0 10px', color: C.textStrong } }, fullEvent.title),
                React.createElement("p", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, lineHeight: 1.6, margin: 0 } },
                    fullEvent.cancellation_reason ? `This event was cancelled: ${fullEvent.cancellation_reason}` : 'This event has been cancelled.'),
                React.createElement("p", { style: { fontSize: TYPE_SCALE[12], color: C.textMuted, lineHeight: 1.6, margin: '12px 0 0' } },
                    'If you paid an entry fee, it is recorded as owed back to you. Refunds for cancelled events are sent by hand, so they can take a little while.'))); 
    }
    if (event === false) {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: { ...S.loadingBlock, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE_SCALE[12] } },
                React.createElement(InkIcon, { name: 'scroll', size: 28, color: C.textMuted }),
                React.createElement("div", null, "This event couldn't be found.")));
    }

    const meta = GED_PHASE_META[event.approvalStatus] || GED_PHASE_META.published;
    // The listing carries three display fields the raw row doesn't (tournament rounds/status, quiz question count).
    const cardEvent = fullEvent
        ? { ...fullEvent, tournamentRounds: event.tournamentRounds, tournamentStatus: event.tournamentStatus, quizQuestionCount: event.quizQuestionCount }
        : null;
    // The wax seal stamped on every official notice: colored by the event's real phase (the same
    // meta.color used on the guild-line label above), so a glance at the seal alone tells a
    // reader upcoming/active/completed without reading the ribbon text.
    return React.createElement("div", { className: "ink-page-in" },
        React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),

        React.createElement(EventPoster, {
            ribbonText: event.host === 'inkroot' ? "Official Inkroot Event" : "Official Guild Event",
            title: event.title, coverImageUrl: event.coverImageUrl, seal: { label: meta.label, color: meta.color },
            // An official event is pinned to a house guild only so it has a home row (migration 185); it is
            // hosted by Inkroot, so the header says so and does not link into that guild.
            hostLine: {
                name: event.host === 'inkroot' ? 'Inkroot' : event.guildName,
                sub: event.host === 'inkroot' ? "\u2014 official event" : "\u2014 host guild",
                onClick: onOpenGuild && event.host !== 'inkroot' ? () => onOpenGuild(event.guildId) : null,
            },
            eventType: event.eventType, timeLeft: gedTimeLeft(event.endAt, event.approvalStatus), howEvent: event,
            description: event.description,
            // The host's rules come from the public listing (migration 170 added them to list_public_guild_events()).
            rules: event.rules,
            stats: [
                { label: 'Entry fee', value: event.entryFeeNaira != null ? formatNaira(event.entryFeeNaira) : 'Free' },
                { label: event.host === 'inkroot' ? 'Cash prize' : 'Prize pool', value: formatNaira(event.prizePoolNaira) },
                { label: 'Participants', value: event.participantCount + (event.participantLimit ? ` / ${event.participantLimit}` : ''),
                    meter: event.participantLimit > 0 ? { fraction: event.participantCount / event.participantLimit, full: event.participantCount >= event.participantLimit } : null },
                { label: 'Dates', value: `${gedFormatDate(event.startAt)} \u2013 ${gedFormatDate(event.endAt)}`, small: true },
            ],
        },
            // Entry + play for this event (see the header comment). Rendered only once the full row loaded.
            cardEvent && React.createElement("div", { style: { marginTop: 18 } },
                React.createElement(EventCard, { event: cardEvent, isOwner: false, members: hostMembers, onChanged: loadFullEvent, onEdit: () => {}, myUserId, isAdmin: !!isAdmin, embedded: true }))));
}

// ---------- The poster: shared by this public page and the guild's own event page (guild-events-section.jsx) ----------
// Pure layout, no fetching: a ribbon, a poster frame with the cover and a wax seal, the host line, type badge, "how it
// works", description and rules, then a ticket stub of stats. `children` go below the stub (the entry / play card).
// stats: [{ label, value, small?, meter?: { fraction, full } }]. seal: { label, color }. hostLine: { name, sub, onClick }.
const GED_POSTER_CSS = `
            /* ---------- Official Guild Event notice ----------
               An Inkroot herald posting, not a storefront card: a poster frame with a hairline
               inner border, a ribbon banner declaring it official, and a wax seal of the event's
               real phase stamped over the corner of the cover art. Ticket-stub stats replace the
               plain stat grid so the entry fee/prize/participants/dates read as one torn stub of
               information rather than four identical little cards. Mobile-first: everything below
               is full-width and single-column by default; the stub only gains its 2-column layout
               once there's room (see the 420px step), matching how tightly an iPhone SE-width
               screen needs to pack this before anything else in the app relaxes its own grid. */
            .ged-poster{position:relative;border:1px solid ${goldA(0.28)};border-radius:${RADIUS_SCALE[16]}px;padding:3px;background:linear-gradient(160deg,${C.noticeTop},${C.noticeDeep} 60%);margin-bottom:22px;}
            .ged-poster::before{content:'';position:absolute;inset:6px;border:1px solid ${goldA(0.16)};border-radius:${RADIUS_SCALE[13]}px;pointer-events:none;}
            .ged-ribbon{display:inline-flex;align-items:center;gap:7px;position:relative;left:16px;top:-1px;margin-bottom:-1px;padding:5px 14px 5px 12px;font-size:12px;letter-spacing:0.1em;color:${C.surfaceDeep};background:linear-gradient(180deg,${C.ribbonTop},${C.gold});border-radius:3px 3px 0 0;font-weight:700;}
            .ged-cover{height:150px;border-radius:${RADIUS_SCALE[13]}px;position:relative;display:flex;align-items:flex-end;padding:18px 20px;overflow:hidden;margin:0;}
            .ged-cover::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,0.7) 100%);}
            .ged-seal{position:absolute;right:12px;top:-20px;width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;transform:rotate(-8deg);box-shadow:0 4px 10px rgba(0,0,0,0.5),inset 0 0 0 1px rgba(0,0,0,0.25);border:2px solid rgba(23,20,15,0.4);z-index:2;}
            .ged-seal-label{font-size:12px;letter-spacing:0.02em;color:${C.surfaceDeep};font-weight:700;line-height:1.15;text-align:center;}
            .ged-body{padding:18px 20px 20px;}
            .ged-stub{position:relative;border:1px dashed rgba(138,134,128,0.4);border-radius:${RADIUS_SCALE[12]}px;padding:16px 14px;background:${C.noticeStub};display:grid;grid-template-columns:1fr 1fr;gap:14px 10px;margin-bottom:4px;}
            .ged-stub::before,.ged-stub::after{content:'';position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:${C.noticeNotch};transform:translateY(-50%);}
            .ged-stub::before{left:-9px;}
            .ged-stub::after{right:-9px;}
            .ged-stat-label{font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:${C.textMuted};}
            .ged-stat-value{font-size:15px;color:${C.text};margin-top:3px;font-family:'Fraunces',Georgia,serif;}
            .ged-meter{height:4px;margin-top:7px;border-radius:100px;background:${C.border};overflow:hidden;}
            .ged-meter>span{display:block;height:100%;background:${C.gold};transition:width var(--ink-dur) var(--ink-ease);}
            .ged-meter.full>span{background:${C.danger};}
            .ged-timeleft{display:inline-flex;align-items:center;gap:6px;margin:0 0 14px;padding:4px 12px;border-radius:100px;font-size:13px;color:${C.goldBright};background:${goldA(0.10)};border:1px solid ${goldA(0.35)};font-variant-numeric:tabular-nums;}
            @media (min-width: 560px) { .ged-stub{grid-template-columns:repeat(4,1fr);} }
        `;

export function EventPoster({ ribbonText, title, coverImageUrl, seal, hostLine, eventType, timeLeft, howEvent, description, rules, stats, children }) {
    return React.createElement("div", null,
        React.createElement("style", null, GED_POSTER_CSS),
        React.createElement("div", { className: "ged-ribbon" }, withIcon('scales', ribbonText, 13)),
        React.createElement("div", { className: "ged-poster" },
            React.createElement("div", { className: "ged-cover", style: { background: coverImageUrl ? `url(${coverImageUrl}) center/cover` : `linear-gradient(155deg, ${C.medalBronze}66, ${C.noticeDeep} 75%)` } },
                React.createElement("div", {
                    className: "ged-seal",
                    style: { background: `radial-gradient(circle at 35% 30%, ${seal.color}, ${seal.color}CC 70%)` },
                },
                    React.createElement("div", { className: "ged-seal-label" }, seal.label)),
                React.createElement("h1", { style: { position: 'relative', fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: TYPE_SCALE[22], margin: 0, color: C.textStrong } }, title)),

            React.createElement("div", { className: "ged-body" },
                hostLine && React.createElement("div", {
                    style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 18, cursor: hostLine.onClick ? 'pointer' : 'default' },
                    onClick: () => hostLine.onClick && hostLine.onClick(),
                },
                    React.createElement(InkIcon, { name: "castle", size: 15 }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: C.text } }, hostLine.name),
                    hostLine.sub && React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: C.textMuted, marginLeft: 4 } }, hostLine.sub)),

                eventType && React.createElement(EventTypeBadge, { eventType, style: { marginBottom: 14 } }),
                timeLeft && React.createElement("div", null, React.createElement("span", { className: "ged-timeleft" }, withIcon('hourglass', timeLeft, 14))),
                howEvent && React.createElement(EventHowItWorks, { event: howEvent, style: { marginTop: 0, marginBottom: 14 } }),

                description && React.createElement("p", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, lineHeight: 1.6, marginBottom: 18 } }, description),

                rules && React.createElement("div", { style: { marginBottom: 18 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 } }, 'Rules'),
                    React.createElement("p", { style: { fontSize: TYPE_SCALE[12.5], color: C.textSoft, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0 } }, rules)),

                React.createElement("div", { className: "ged-stub" },
                    (stats || []).map((st) => React.createElement("div", { key: st.label },
                        React.createElement("div", { className: "ged-stat-label" }, st.label),
                        React.createElement("div", { className: "ged-stat-value", style: st.small ? { fontSize: TYPE_SCALE[12.5] } : undefined }, st.value),
                        st.meter && React.createElement("div", { className: `ged-meter${st.meter.full ? ' full' : ''}`, "aria-hidden": "true" },
                            React.createElement("span", { style: { width: `${Math.max(0, Math.min(100, st.meter.fraction * 100))}%` } }))))),

                children)));
}
