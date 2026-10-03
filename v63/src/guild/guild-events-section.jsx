import { S } from './guild-styles.js';
import { C, goldA } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { EVENT_APPROVAL_COLORS, EVENT_APPROVAL_LABELS, EVENT_TYPE_COLORS, EVENT_TYPE_ICONS, EVENT_TYPE_LABELS, BackLink, evTapBtn, formatEventDate } from './guild-event-ui.jsx';
import { EventPoster, gedTimeLeft } from './guild-event-detail-screen.jsx';
import { EventCard } from './guild-event-card.jsx';
import { GuildEventForm } from './guild-event-form.jsx';
import {
    createGuildEventDraft, fetchCurrentGuildEventHostingFeeNaira, fetchGuildEventEntryCount,
    fetchGuildEventFinancialAgreement, fetchGuildEvents, fetchPlatformFeePct,
    proposeGuildEventFinancialAgreement, updateGuildEventDraft,
} from '../lib/guild-events.js';
import { fetchGuildTreasuryRole } from '../lib/guild-treasury.js';
import { QuestionPool } from './guild-quiz-question-pool.jsx';
import { formatNaira } from '../lib/payments.js';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------- Guild Events section (frontend only — see src/guild/guild-event-card.jsx, guild-event-form.jsx and
// src/lib/guild-events.js for the real, already-built backend wiring this reuses wholesale:
// EventCard for every lifecycle control, GuildEventForm for the create/edit form itself, and
// every RPC call for creating, approving, publishing, activating, entering, and settling an
// event). This file adds the browsing shell the backend never had a Guild-facing home for:
// a tabbed Upcoming/Active/Completed list, a dedicated Create Event page, and a dedicated Event
// Details page — all mobile-first, all using only what fetchGuildEvents already returns.
//
// "Official Inkroot Events" (host === 'inkroot') are created only by an Inkroot admin — see
// src/admin/inkroot-events-admin.jsx. There is no client-callable way to create one, and nothing
// in this file exposes one; when Inkroot hosts a cash-prize event for this guild it simply shows
// up in the same list, clearly labelled, exactly as fetchGuildEvents already returns it.
//
// approval_status is the single source of truth for what's safe to show/enter, and every write
// this file makes goes through the same guarded RPCs the rest of the app already uses
// (create_guild_event_draft, submit_guild_event_for_approval, etc.) — there is no shortcut here
// that publishes, activates, or enters an event without Inkroot's review and, where relevant,
// payment. See 45_migration_guild_event_creation_workflow.sql for the lifecycle this walks.

function statusOf(event) {
    return event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
}

// 'Upcoming' is what everyone can see (published, not yet open). Everything that is still being set up or reviewed lives in
// 'Drafts', which only the owner gets: the server returns those rows to nobody else (fetchGuildEvents includeAllStatuses),
// and mixing them into Upcoming made a host's own work-in-progress look like events people could already join.
const EVENT_TABS = [
    { key: 'upcoming', label: 'Upcoming', statuses: ['published'] },
    { key: 'active', label: 'Active', statuses: ['active'] },
    { key: 'completed', label: 'Completed', statuses: ['completed'] },
    { key: 'drafts', label: 'Drafts', statuses: ['draft', 'pending_approval', 'approved', 'rejected'], ownerOnly: true },
];

function formatShortDate(value) {
    if (!value) return null;
    try { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return null; }
}

// ---------- Compact preview card — the Upcoming/Active/Completed list itself. Full detail,
// entry, and lifecycle controls only live on the Event Details page (EventCard, opened on tap)
// so a guild with several events doesn't turn into a wall of forms and buttons to scroll past.
function EventPreviewCard({ event, entryCount, organizerName, onOpen }) {
    const status = statusOf(event);
    const statusColor = EVENT_APPROVAL_COLORS[status] || C.gold;
    const dateRange = [formatShortDate(event.start_date), formatShortDate(event.end_date)].filter(Boolean).join(' \u2013 ');
    const typeColor = EVENT_TYPE_COLORS[event.event_type] || C.neutralSoft;
    const TypeIcon = EVENT_TYPE_ICONS[event.event_type];
    const full = !!event.participant_limit && entryCount != null && entryCount >= event.participant_limit;
    // Line 2: what kind of event it is, and what it costs (or pays, for an official one).
    const money = event.host === 'inkroot' ? `Official \u2014 ${formatNaira(event.cashPrizeNaira)} prize` : (event.event_type === 'giveaway' ? 'Free entry' : `Entry ${formatNaira(event.entryFeeNaira)}`);
    // Line 3: when, and who runs it. Wraps instead of cutting the date off.
    const when = [dateRange, organizerName ? `by ${organizerName}` : null].filter(Boolean).join(' \u00B7 ');
    return React.createElement("button", {
        onClick: onOpen, "aria-label": `${event.title || 'Untitled event'}, ${EVENT_APPROVAL_LABELS[status] || status}. Open details.`,
        style: {
            display: 'flex', width: '100%', textAlign: 'left', gap: SPACE_SCALE[12], alignItems: 'flex-start', minHeight: 72,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 12,
            marginBottom: 10, cursor: 'pointer', font: 'inherit', color: 'inherit',
        },
    },
        // The cover when the host set one; otherwise a tile in the event type's own colour, so a list of events can be
        // scanned by kind (tournament, quiz, writing, giveaway, world building) without reading each line.
        event.cover_image_url
            ? React.createElement("img", { src: event.cover_image_url, alt: "", style: { width: 52, height: 52, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], flexShrink: 0 } })
            : React.createElement("div", { "aria-hidden": "true", style: { width: 52, height: 52, borderRadius: RADIUS_SCALE[8], background: `${typeColor}1A`, border: `1px solid ${typeColor}55`, color: typeColor, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
                TypeIcon ? React.createElement(TypeIcon, { width: 24, height: 24 }) : React.createElement(InkIcon, { name: event.host === 'inkroot' ? "columns" : "flame", size: 22, color: typeColor })),
        React.createElement("div", { style: S.fill },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], alignItems: 'flex-start' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], lineHeight: 1.3, color: C.text, fontWeight: 600, minWidth: 0, overflowWrap: 'anywhere' } }, event.title || 'Untitled event'),
                React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', fontSize: TYPE_SCALE[10.5], textTransform: 'uppercase', letterSpacing: '0.04em', color: statusColor, flexShrink: 0, padding: '2px 8px', borderRadius: 100, background: `${statusColor}1A`, border: `1px solid ${statusColor}50` } }, EVENT_APPROVAL_LABELS[status] || status)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textDim, marginTop: 4, lineHeight: 1.4 } },
                EVENT_TYPE_LABELS[event.event_type] && React.createElement("span", { style: { color: typeColor, fontWeight: 600 } }, EVENT_TYPE_LABELS[event.event_type]),
                EVENT_TYPE_LABELS[event.event_type] && ' \u00B7 ', money),
            when && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, marginTop: 2, lineHeight: 1.4 } }, when),
            entryCount != null && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: full ? C.danger : C.textSoft, marginTop: 2 } },
                event.participant_limit ? `${entryCount} / ${event.participant_limit} joined${full ? ' \u2014 full' : ''}` : `${entryCount} joined`)));
}

// ---------- Hosting fee notice — shown up front while creating an event, so a guild sees
// Inkroot's cut before finishing the form, not only once the event's already been approved (the
// actual charge still only happens later, via HostingFeePanel inside EventCard, once Inkroot has
// approved the event — nothing here collects payment).
function HostingFeeNotice() {
    const [feeNaira, setFeeNaira] = useState(undefined);
    useEffect(() => { let c = false; fetchCurrentGuildEventHostingFeeNaira().then((f) => { if (!c) setFeeNaira(f); }).catch(() => { if (!c) setFeeNaira(null); }); return () => { c = true; }; }, []);
    return React.createElement("div", { style: { background: C.surfaceRaised, border: `1px solid ${goldA(0.3)}`, borderRadius: RADIUS_SCALE[10], padding: '11px 13px', marginBottom: 12, display: 'flex', gap: SPACE_SCALE[10], alignItems: 'flex-start' } },
        React.createElement(InkIcon, { name: "moneybag", size: 16, color: C.goldBright, style: { marginTop: 1, flexShrink: 0 } }),
        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600, color: C.goldBright } },
                feeNaira === undefined ? 'Checking Inkroot\u2019s hosting fee\u2026' : feeNaira == null ? 'Inkroot hosting fee' : `Inkroot hosting fee \u2014 ${formatNaira(feeNaira)}`),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.goldMuted, marginTop: 3, lineHeight: 1.5 } },
                "A one-time charge to Inkroot, separate from the per-entry platform fee. You\u2019ll pay it after Inkroot approves this event, before it publishes \u2014 it never blocks saving or submitting a draft.")));
}

// ---------- Event Details page — the same poster the public event page uses (ribbon, cover, wax seal, ticket stub; see
// EventPoster in guild-event-detail-screen.jsx), so one event never looks like two different things depending on where it
// was opened from. Below the stub sits the EventCard in `headerless` mode: it supplies everything the poster doesn't
// (the entry state, the money breakdown, and every owner / organizer lifecycle control), and the stub carries the facts
// the old two-box header and the card's own stat grid used to split between them: entry fee, prize pool, who has joined,
// and the dates. The prize pool is the guild's locked split of each entry fee, or Inkroot's cash prize for an official event.
const POSTER_SEAL_LABELS = { draft: 'Draft', pending_approval: 'In review', approved: 'Approved', published: 'Upcoming', active: 'Active', completed: 'Completed', rejected: 'Sent back' };

function EventDetailsPage({ event, isOwner, members, canApprove, myUserId, entryCount, onBack, onChanged, onEdit }) {
    const [agreement, setAgreement] = useState(undefined);
    useEffect(() => {
        if (event.host !== 'guild') { setAgreement(null); return; }
        let cancelled = false;
        fetchGuildEventFinancialAgreement(event.id).then((a) => { if (!cancelled) setAgreement(a); }).catch(() => setAgreement(null));
        return () => { cancelled = true; };
    }, [event.id, event.host]);

    const status = statusOf(event);
    const isOfficial = event.host === 'inkroot';
    const organizer = members.find((m) => m.user_id === event.organizer_id);
    const prizePoolLine = isOfficial
        ? formatNaira(event.cashPrizeNaira)
        : agreement === undefined ? '\u2026'
            : agreement ? `${agreement.prize_pool_bps / 100}% of every entry fee`
                : 'Not set yet';
    const limit = event.participant_limit;
    const dates = [formatEventDate(event.start_date), formatEventDate(event.end_date)].filter(Boolean).join(' \u2013 ');
    // "Official" is Inkroot's review stamp, so an event that hasn't been through review yet is not called that.
    const notReviewed = ['draft', 'pending_approval', 'rejected'].includes(status);

    return React.createElement("div", { className: "ink-page-in" },
        React.createElement(BackLink, { onClick: onBack, marginBottom: 12 }, "\u2190 Back to Guild Events"),

        React.createElement(EventPoster, {
            ribbonText: isOfficial ? 'Official Inkroot Event' : notReviewed ? 'Guild Event \u2014 not yet approved' : 'Official Guild Event',
            title: event.title || 'Untitled event', coverImageUrl: event.cover_image_url,
            seal: { label: POSTER_SEAL_LABELS[status] || EVENT_APPROVAL_LABELS[status] || status, color: EVENT_APPROVAL_COLORS[status] || C.gold },
            hostLine: { name: isOfficial ? 'Inkroot' : (organizer ? (organizer.name || organizer.user_id) : 'Organizer not yet assigned'), sub: isOfficial ? '\u2014 official event' : '\u2014 organizer' },
            eventType: event.event_type, timeLeft: gedTimeLeft(event.end_date, status), howEvent: event,
            description: event.description, rules: event.rules,
            stats: [
                { label: 'Entry fee', value: event.event_type === 'giveaway' || event.entryFeeNaira == null ? 'Free' : formatNaira(event.entryFeeNaira) },
                { label: isOfficial ? 'Cash prize' : 'Prize pool', value: prizePoolLine, small: !isOfficial },
                { label: 'Participants', value: entryCount != null ? `${entryCount}${limit ? ` / ${limit}` : ''}` : (limit ? `Limit ${limit}` : '\u2014'),
                    meter: limit > 0 && entryCount != null ? { fraction: entryCount / limit, full: entryCount >= limit } : null },
                { label: 'Dates', value: dates || '\u2014', small: true },
            ],
        },
            React.createElement("div", { style: { marginTop: 18 } },
                React.createElement(EventCard, { event, isOwner, members, onChanged, onEdit, canApprove, myUserId, headerless: true }))));
}

// ---------- Real, guild-scoped Guild Events browsing UI ----------
function GuildEventsReal({ guildId, isOwner, isFounderView, guildKey, initialAction }) {
    const [events, setEvents] = useState([]);
    const [members, setMembers] = useState([]);
    const [entryCounts, setEntryCounts] = useState({});
    const [role, setRole] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('upcoming');
    // initialAction: an optional starting point for a caller that already knows the writer wants
    // to create an event — e.g. the Guild Homepage's Guild Events preview, when there's no
    // upcoming event and this writer owns the guild (see home-screen.jsx's pendingEventAction).
    // Same pattern as GuildAnthologyScreen's initialAction/showCreate. Undefined for every other
    // way into this tab, so it lands on the list exactly as before.
    const [view, setView] = useState(initialAction === 'create' ? 'create' : 'list'); // 'list' | 'create' | 'details'
    const [editingEvent, setEditingEvent] = useState(null);
    const [selectedEventId, setSelectedEventId] = useState(null);

    const canApprove = isOwner || role === 'treasurer' || role === 'officer';
    // Quiz question review is narrower than event approval: the owner and officers only, no treasurers
    // (migration 183, guild_quiz_can_review()).
    const canReviewQuestions = isOwner || role === 'officer';

    const load = () => {
        // A Founder Guild's real roster lives in founder_guild_members, keyed by its text slug
        // (guildKey), not by guildId (the backend uuid) — see fetchFounderGuildMembers' own
        // header comment. Shape matches fetchPlayerGuildMembers closely enough (user_id,
        // joined_at, name; no role, since a Founder Guild has no Treasurer/Officer rows) that
        // every existing use of `members` below (organizer lookup, the create-event form) works
        // unchanged either way.
        const membersPromise = isFounderView ? fetchFounderGuildMembers(guildKey) : fetchPlayerGuildMembers(guildId);
        Promise.all([fetchGuildEvents(guildId, { includeAllStatuses: isOwner }), membersPromise])
            .then(([evts, mems]) => {
                setEvents(evts);
                setMembers(mems);
                setLoading(false);
                Promise.all(evts.filter((e) => e.host === 'guild').map((e) => fetchGuildEventEntryCount(e.id).then((c) => [e.id, c]).catch(() => [e.id, null])))
                    .then((pairs) => setEntryCounts(Object.fromEntries(pairs)));
            })
            .catch((e) => { setError(e.message || 'Could not open guild events.'); setLoading(false); });
        fetchGuildTreasuryRole(guildId).then(setRole).catch(() => {});
        currentUser().then((u) => setMyUserId(u ? u.id : null)).catch(() => {});
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [guildId]);

    const openCreate = () => { setEditingEvent(null); setView('create'); };
    const openEdit = (event) => { setEditingEvent(event); setView('create'); };
    const openDetails = (event) => { setSelectedEventId(event.id); setView('details'); };
    const backToList = () => { setView('list'); setEditingEvent(null); setSelectedEventId(null); };

    const handleSaveForm = async (fields) => {
        const { financial, ...eventFields } = fields;
        const event = editingEvent
            ? await updateGuildEventDraft(guildId, editingEvent.id, eventFields)
            : await createGuildEventDraft(guildId, eventFields);
        const platformFeePct = await fetchPlatformFeePct();
        await proposeGuildEventFinancialAgreement(guildId, event.id, { ...financial, platformFeeBps: platformFeePct * 100 });
        backToList();
        // A new or edited event is a draft, so show the owner the Drafts tab where it now lives.
        setTab(isOwner ? 'drafts' : 'upcoming');
        load();
    };

    if (loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: C.textMuted, fontSize: TYPE_SCALE[12.5], padding: '30px 10px' } }, "Opening Guild Events\u2026");
    }

    if (view === 'create') {
        return React.createElement("div", null,
            React.createElement(BackLink, { onClick: backToList }),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], color: C.text, fontWeight: 600, marginBottom: 4 } },
                editingEvent ? 'Edit guild event' : 'Host a guild event'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginBottom: 12 } },
                "Every new event starts as a draft and only goes live once Inkroot reviews and approves it \u2014 there\u2019s no way to publish or open entries before that."),
            React.createElement(HostingFeeNotice, null),
            React.createElement(GuildEventForm, { members, initial: editingEvent, onCancel: backToList, onSave: handleSaveForm }));
    }

    if (view === 'pool') {
        return React.createElement("div", null,
            React.createElement(BackLink, { onClick: backToList }),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], color: C.text, fontWeight: 600, marginBottom: 10 } }, 'Question pool'),
            React.createElement(QuestionPool, { mode: 'guild', guildId, canReview: canReviewQuestions, members }));
    }

    if (view === 'details') {
        const event = events.find((e) => e.id === selectedEventId);
        if (!event) { backToList(); return null; }
        return React.createElement(EventDetailsPage, {
            event, isOwner: isOwner && event.host === 'guild', members, onBack: backToList, entryCount: entryCounts[event.id],
            onChanged: load, onEdit: (ev) => { openEdit(ev); }, canApprove: canApprove && event.host === 'guild', myUserId,
        });
    }

    // ---------- List view ----------
    const visibleTabs = EVENT_TABS.filter((t) => !t.ownerOnly || isOwner);
    const activeTabDef = visibleTabs.find((t) => t.key === tab) || visibleTabs[0];
    const filtered = events.filter((e) => activeTabDef.statuses.includes(statusOf(e)));
    const counts = Object.fromEntries(EVENT_TABS.map((t) => [t.key, events.filter((e) => t.statuses.includes(statusOf(e))).length]));
    // An event Inkroot has approved is waiting on the host (pay the hosting fee, then publish), so the Drafts tab says so.
    const needsHost = events.some((e) => statusOf(e) === 'approved');
    const canHost = isOwner && !isFounderView;
    // Empty tabs say why, and for the owner offer the one thing that fills them.
    const emptyLine = tab === 'upcoming' ? 'No upcoming events yet.' : tab === 'active' ? 'No events are open for entries right now.'
        : tab === 'drafts' ? 'No drafts. Start one and it will wait here until Inkroot has reviewed it.' : 'No completed events yet.';
    const emptyAction = canHost && ['upcoming', 'drafts'].includes(tab);

    return React.createElement("div", { className: "ik-ev" },
        React.createElement("style", null, `
            /* Guild Events list \u2014 the same herald-notice language as the public Event Details
               page (see guild-event-detail-screen.jsx's .ged-ribbon) carried onto the guild's own
               management view, so browsing here already feels like an official noticeboard
               rather than a plain settings list. */
            .gev-board-banner{position:relative;border-radius:${RADIUS_SCALE[14]}px;border:1px solid rgba(184,115,92,0.28);background:linear-gradient(160deg,${C.noticeBannerTop},${C.noticeDeep} 70%);padding:18px 18px 16px;margin-bottom:16px;text-align:center;}
            .gev-board-banner::before{content:'';position:absolute;left:14px;right:14px;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(184,115,92,0.5),transparent);}
        `),
        React.createElement("div", { className: "gev-board-banner" },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], letterSpacing: '0.16em', textTransform: 'uppercase', color: C.copper, marginBottom: 6 } }, "Official Noticeboard"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], color: C.text, fontWeight: 600 } }, 'Guild Events'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 6, fontStyle: 'italic', maxWidth: 320, margin: '6px auto 0' } },
                "Competitions this guild hosts and settles itself. Official Inkroot Events \u2014 cash prizes Inkroot funds and awards directly \u2014 show up here too, clearly marked.")),

        error && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11.5], marginBottom: 10, textAlign: 'center' } }, error),

        // The one primary action on this screen. Question pool is a secondary tool and sits under the list.
        canHost && React.createElement("button", { onClick: openCreate, style: { ...evTapBtn(true, true), width: '100%', marginBottom: 14 } }, '+ Host a Guild Event'),
        // A Founder Guild has no treasury to fund its own entry-fee event from (see
        // 122_migration_founder_guild_no_treasury_or_hosting.sql) — Inkroot can still run an
        // official cash-prize event here, which shows up in the list above like any other.
        isOwner && isFounderView && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, fontStyle: 'italic', textAlign: 'center', marginBottom: 14 } },
            "A Founder Guild can't host its own event \u2014 only Inkroot can run an official cash-prize event here."),

        React.createElement("div", { role: "tablist", "aria-label": "Guild events", style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 14 } },
            visibleTabs.map((t) => {
                const on = activeTabDef.key === t.key;
                // A gold dot on Drafts while an approved event is waiting on the host.
                const attention = t.key === 'drafts' && needsHost && !on;
                return React.createElement("button", {
                    key: t.key, role: "tab", "aria-selected": on, onClick: () => setTab(t.key),
                    style: {
                        flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minHeight: 48, padding: '8px 4px', borderRadius: RADIUS_SCALE[12],
                        border: `1px solid ${on ? goldA(0.5) : C.border}`,
                        background: on ? `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` : C.surface,
                        color: on ? C.goldBright : C.textSoft, cursor: 'pointer', position: 'relative',
                    },
                },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600 } }, t.label),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12], opacity: 0.8, fontVariantNumeric: 'tabular-nums' } }, counts[t.key]),
                    attention && React.createElement("span", { "aria-label": "needs your attention", style: { position: 'absolute', top: 6, right: 8, width: 8, height: 8, borderRadius: '50%', background: C.goldBright } }));
            })),

        activeTabDef.key === 'drafts' && filtered.length > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, lineHeight: 1.5, marginBottom: 12 } },
            'Only you can see these. ', needsHost ? 'An approved event is waiting for you to pay the hosting fee and publish it.' : 'Inkroot reviews each one before it can go live.'),

        filtered.length === 0
            ? React.createElement("div", { style: { textAlign: 'center', padding: '20px 10px' } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textMuted, lineHeight: 1.5, maxWidth: 300, margin: '0 auto 12px' } }, emptyLine),
                emptyAction && React.createElement("button", { onClick: openCreate, style: evTapBtn(false) }, tab === 'drafts' ? 'Start a draft' : 'Host a guild event'))
            : filtered.map((event) => React.createElement(EventPreviewCard, {
                key: event.id, event, entryCount: entryCounts[event.id],
                organizerName: (members.find((m) => m.user_id === event.organizer_id) || {}).name,
                onOpen: () => openDetails(event),
            })),

        // Secondary tool, kept out of the way of the primary action above: the shared bank of quiz and tournament questions.
        React.createElement("div", { style: { ...S.divider, marginTop: 16 } },
            React.createElement("button", { onClick: () => setView('pool'), style: { ...evTapBtn(false), width: '100%' } }, 'Question pool'),
            React.createElement("div", { style: { ...S.noteCaption, marginTop: 6 } }, 'Questions for this guild\u2019s quizzes and tournaments.')));
}

// remoteGuildId is a real player_guilds.id for both guild types now — a Player Guild's own real
// row, or a Founder Guild's fixed backendGuildId (see FOUNDER_GUILDS in guild-hall.jsx and
// supabase/history/69_migration_founder_guild_parity.sql), set by home-screen.jsx's
// guildOrderBackendId. null only for being signed out or offline, which is exactly when this
// stays a plain locked notice rather than inventing simulated events (there's no honest way to
// simulate a real-money entry fee and payout the way GoTreasuryTabSimulated simulates Guild
// Coin). isOwner only affects which controls this renders; every write the real view makes is
// still re-authorized server-side regardless of what this prop says.
export function GoGuildEventsSection({ remoteGuildId, isOwner, isFounderView, guildKey, initialAction }) {
    if (!remoteGuildId) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement(InkIcon, { name: 'lock', size: 22, color: C.textMuted, style: { margin: '0 auto 12px' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textSoft, maxWidth: 260, margin: '0 auto', lineHeight: 1.55 } },
                "Guild Events need a signed-in, online guild \u2014 sign in and join or found a guild to host or enter one."));
    }
    return React.createElement(GuildEventsReal, { guildId: remoteGuildId, isOwner, isFounderView, guildKey, initialAction });
}
