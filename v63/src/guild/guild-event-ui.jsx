import { C, goldA, successA, dangerA, infoA, amberA } from './guild-theme.js';
import { S } from './guild-styles.js';
import React from 'react';
import {
    IconEventGiveaway, IconEventOther, IconEventReadingChallenge, IconEventTournament,
    IconEventWorkshop, IconEventWritingContest,
} from '../shared-ui/icons.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// Deliberately not imported from guild-order.jsx (which renders this panel) — same one-way-copy
// reasoning as guild-member-earnings.jsx's own local style helpers.
export function evBtnStyle(primary) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', borderRadius: RADIUS_SCALE[8], cursor: 'pointer',
        border: primary ? `1px solid ${goldA(0.5)}` : `1px solid ${C.border}`,
        background: primary ? `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` : 'transparent',
        color: primary ? C.goldBright : C.textSoft,
    };
}
// One field style for every event screen, host and entrant: 44px minimum height so a field is easy to tap on a phone.
export const evInputStyle = { background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], color: C.text, padding: '8px 10px', fontSize: TYPE_SCALE[13], minHeight: 44, width: '100%', boxSizing: 'border-box' };
// Touch-sized button variants for the entrant panels (writing, submission, reading challenge, world building, giveaway):
// 44px for ordinary buttons, 52px for the one main action. Fields no longer need a variant: evInputStyle is 44px itself.
export const evTapBtn = (primary, main) => ({
    ...evBtnStyle(primary), minHeight: main ? 52 : 44,
    ...(main ? { fontSize: TYPE_SCALE[13], borderRadius: RADIUS_SCALE[12], padding: '10px 16px' } : null),
});
export const evLabelStyle = S.capsLabel;

// Guild Event creation — see 45_migration_guild_event_creation_workflow.sql. approval_status is
// the lifecycle this form and the buttons below walk an event through:
//   draft -> pending_approval -> approved -> published -> active -> completed
//   (or draft/pending_approval -> rejected, which stays unpublished until edited back to draft
//   and resubmitted)
// Human-readable labels + a color per stage, used by both the EventCard badge and the admin
// queue.
export const EVENT_APPROVAL_LABELS = {
    draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved',
    published: 'Published', active: 'Active', completed: 'Completed', rejected: 'Rejected',
    cancelled: 'Cancelled',
};
export const EVENT_APPROVAL_COLORS = {
    draft: C.neutralMid, pending_approval: C.gold, approved: C.info, published: C.info,
    active: C.success, completed: C.success, rejected: C.danger,
    // 'cancelled' has no producer anywhere server-side today (see 45_migration_guild_event_creation_workflow.sql's
    // approval_status check \u2014 'cancelled' isn't one of the allowed values), so this key is
    // inert until the backend ever adds one. Kept here \u2014 same as the entry-status handling
    // in EventCard below \u2014 so the UI doesn't need another pass the day it does.
    cancelled: C.danger,
};
// 'workshop' is repurposed here to mean World-Building events, per the redesign spec — it is
// NOT a new DB value. guild_events.event_type's check constraint (see
// 45_migration_guild_event_creation_workflow.sql) only allows 'tournament', 'writing_contest',
// 'reading_challenge', 'giveaway', 'workshop', 'other', with no 'world_building' among them, so
// rather than block on a migration this reuses the existing, previously-generic 'workshop' slot:
// the stored value stays 'workshop', only the label + entrant experience (see
// guild-event-world-building-panel.jsx) changed. If a real, separate Workshop event type is ever
// wanted later, it would need its own new DB value — this slot is now World-Building's.
export const EVENT_TYPE_LABELS = {
    tournament: 'Tournament', writing_contest: 'Writing contest', reading_challenge: 'Quiz',
    giveaway: 'Giveaway', workshop: 'World Building', other: 'Other',
};
// A distinct, muted tint per event type — deliberately its own palette from
// EVENT_APPROVAL_COLORS above so a type badge is never mistaken for a status badge sitting next
// to it on the same card. No type shares a hue with a status: statuses use grey, gold, blue, green
// and red; types use copper, violet, teal, pink and olive (plus a warm grey for 'other').
export const EVENT_TYPE_COLORS = {
    tournament: C.typeTournament, writing_contest: C.copper, reading_challenge: C.typeQuiz,
    giveaway: C.typeGiveaway, workshop: C.typeWorkshop, other: C.textMuted,
};
export const EVENT_TYPE_ICONS = {
    tournament: IconEventTournament, writing_contest: IconEventWritingContest, reading_challenge: IconEventReadingChallenge,
    giveaway: IconEventGiveaway, workshop: IconEventWorkshop, other: IconEventOther,
};

// Judging — see 121_migration_guild_event_fair_judging.sql. Placements are computed, never
// declared: an objective metric (scored off data the server already has) and/or a blind judge
// panel (3-5 Inkroot admin judges, assigned automatically, outside the hosting guild) combine into a
// ranked result. Every host='guild' event needs one of these on file before it can activate —
// there is no event type that skips this step, including giveaway/workshop (see the note
// JudgingConfigSection renders for those two below).
export const OBJECTIVE_METRIC_LABELS = { none: 'None — judge panel only', word_count: 'Word count', on_time_completion: 'On-time completion' };

// The event-type pill shown on both a guild's own event cards (EventCard below) and Inkroot
// Admin's pending-submission rows — one place so the glyph/tint/label can never drift between
// the two. Renders nothing for an event with no recognized type.
// Per-type wording for the entry button and the "you're in" confirmation \u2014 same actions
// underneath (one paid entry via enterGuildEvent), just named for what the entrant is actually
// doing. Wording only claims what every type's entrant panel below really does today.
const EVENT_ENTRY_COPY = {
    tournament: { cta: 'Join the tournament', done: 'Registration successful \u2014 you\u2019re in the tournament' },
    writing_contest: { cta: 'Start your entry', done: 'Registration successful \u2014 submit your piece below' },
    reading_challenge: { cta: 'Join the challenge', done: 'Registration successful \u2014 you\u2019re in the challenge' },
    giveaway: { cta: 'Get a ticket', done: 'Ticket secured \u2014 you\u2019re in the draw' },
    workshop: { cta: 'Start your entry', done: 'Registration successful \u2014 choose your piece below' },
    other: { cta: 'Enter', done: 'Registration successful \u2014 you\u2019re entered' },
};
export const entryCopyFor = (eventType) => EVENT_ENTRY_COPY[eventType] || EVENT_ENTRY_COPY.other;

// One plain-language line on how an event works, per type. Accepts either row shape (the full
// snake_case event EventCard gets, or the camelCase one the public detail screen gets) and only
// says what's true from the fields actually present \u2014 optional per-type fields (word range,
// draw method, quiz book, bracket) that the backend doesn't supply yet simply aren't mentioned,
// so nothing here promises something an event can't do. Returns null when there's nothing to say.
function eventHowItWorks(event) {
    if (!event) return null;
    const type = event.event_type || event.eventType;
    const minW = event.minWordCount != null ? Number(event.minWordCount) : null;
    const maxW = event.maxWordCount != null ? Number(event.maxWordCount) : null;
    if (type === 'writing_contest') {
        const range = minW != null && maxW != null ? ` Entries must be ${minW}\u2013${maxW} words.`
            : minW != null ? ` Entries must be at least ${minW} words.`
                : maxW != null ? ` Entries must stay under ${maxW} words.` : '';
        return `Paste, upload a .txt file, or link one of your projects before the event ends.${range}`;
    }
    if (type === 'workshop') {
        return 'Submit a map, family tree, location or relationship web from your own World Bible. Judged blind by a panel of Inkroot judges \u2014 no word count involved.';
    }
    if (type === 'giveaway') {
        const draw = event.drawMethod === 'weighted_random' ? 'Every ticket is one chance in a weighted random draw. '
            : event.drawMethod === 'highest_entries' ? 'The entrant with the most tickets wins. ' : '';
        return `${draw}Members of the hosting guild can\u2019t enter their own giveaway.`;
    }
    if (type === 'reading_challenge') {
        // Migration 172: a quiz has a server-side time limit (quizTimeLimitSeconds). A reading challenge
        // saved before quizzes existed has none and keeps the original mark-complete wording.
        if (event.quizTimeLimitSeconds) {
            const limit = event.quizTimeLimitSeconds < 120 ? `${event.quizTimeLimitSeconds} seconds` : `${Math.round(event.quizTimeLimitSeconds / 60)} minutes`;
            const book = event.quizSource === 'anthology' ? 'Read the guild\u2019s anthology, then take' : 'Take';
            return `${book} the quiz before entries close \u2014 one attempt, ${limit} once you start. Most correct wins, fastest breaks ties. Members of the hosting guild can\u2019t enter.`;
        }
        return 'Finish the reading and mark it complete before the event ends.';
    }
    if (type === 'tournament') {
        // Migration 176: the rounds come from the public listing (tournamentRounds); the real number played is
        // worked out when entries close, so this says "up to". Members of the hosting guild can't enter.
        const rounds = event.tournamentRounds || (event.tournament && event.tournament.rounds);
        return `${rounds ? `A knockout bracket of up to ${rounds} rounds` : 'A knockout bracket'}, one round per day \u2014 win your match to advance. Most correct answers wins, speed breaks ties. Members of the hosting guild can\u2019t enter.`;
    }
    return null;
}

export function EventHowItWorks({ event, style }) {
    const line = eventHowItWorks(event);
    if (!line) return null;
    return React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.info, marginTop: 6, lineHeight: 1.5, ...style } }, line);
}

export function EventTypeBadge({ eventType, style }) {
    if (!eventType || !EVENT_TYPE_LABELS[eventType]) return null;
    const color = EVENT_TYPE_COLORS[eventType] || C.neutralSoft;
    const Icon = EVENT_TYPE_ICONS[eventType];
    return React.createElement("div", {
        style: {
            display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, padding: '3px 9px 3px 7px',
            borderRadius: 100, fontSize: TYPE_SCALE[10], color, background: `${color}1A`, border: `1px solid ${color}55`,
            ...style,
        },
    },
        Icon && React.createElement(Icon, { style: { flexShrink: 0 } }),
        EVENT_TYPE_LABELS[eventType]);
}

// Guild Event results — organizer submission + required approval, see
// 49_migration_guild_event_results_approval.sql. Distinct from approval_status above: this is
// entirely about whether a *proposed payout* for an already-completed event has been reviewed,
// never about whether the event itself is fit to show readers.
export const RESULTS_STATUS_LABELS = { pending_approval: 'Awaiting approval', approved: 'Approved & paid out', rejected: 'Sent back for revision' };
export const RESULTS_STATUS_COLORS = { pending_approval: C.gold, approved: C.success, rejected: C.danger };

export function formatEventDate(value) {
    if (!value) return null;
    try {
        return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return null;
    }
}

// Converts a value from an <input type="date"> into a fields.startDate/endDate the create/edit
// form can round-trip, and vice versa — kept in one place so the two directions can't drift.
export function toDateInputValue(value) {
    if (!value) return '';
    try { return new Date(value).toISOString().slice(0, 10); } catch (e) { return ''; }
}

// One tinted strip for every "where do I stand" message on an event (you're in / refunded / pending / full / cancelled / judging /
// winners paid). Was three copies (EntryNote in the event card, RcStrip in the results panels); this is the single version.
export function EventNote({ tone = 'neutral', icon, children }) {
    const tones = {
        success: { c: C.success, bg: successA(0.08), b: `${C.success}55` },
        info: { c: C.info, bg: infoA(0.08), b: `${C.info}55` },
        gold: { c: C.gold, bg: amberA(0.08), b: `${C.gold}55` },
        danger: { c: C.danger, bg: dangerA(0.08), b: `${C.danger}55` },
        neutral: { c: C.textSoft, bg: C.panel, b: C.border },
    };
    const t = tones[tone] || tones.neutral;
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SPACE_SCALE[8], padding: '10px 12px', borderRadius: RADIUS_SCALE[12], background: t.bg, border: `1px solid ${t.b}`, fontSize: TYPE_SCALE[12.5], lineHeight: 1.45, color: t.c } },
        icon && React.createElement(InkIcon, { name: icon, size: 18, color: t.c }),
        React.createElement("span", { style: { flex: 1, minWidth: 0 } }, children));
}

// The "\u2190 Back" button at the top of a Guild Events sub-screen (was hand-built three times in guild-events-section.jsx).
export function BackLink({ onClick, children = '\u2190 Back', marginBottom = 10 }) {
    return React.createElement("button", { onClick, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: 'none', color: C.textSoft, fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer', minHeight: 44, padding: '4px 2px', marginBottom } }, children);
}
