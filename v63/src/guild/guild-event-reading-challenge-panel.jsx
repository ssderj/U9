import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { EntrantResultStrip } from './guild-event-results-panels.jsx';
import { evTapBtn } from './guild-event-ui.jsx';
import { TYPE_SCALE } from '../shell/nav-context.jsx';

function daysUntil(dateStr) {
    if (!dateStr) return null;
    const ms = new Date(dateStr).getTime() - Date.now();
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function formatDate(dateStr) {
    if (!dateStr) return null;
    try { return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return null; }
}

// Entrant-facing reading-challenge panel — see 121_migration_guild_event_fair_judging.sql and
// the design brief's own note that a reading challenge is lighter-weight than a
// tournament/writing-contest entry: a single "Mark complete" action instead of a manuscript
// field, progress against the event's end date, no scoring UI (an entrant never sees judge
// scoring in either page — that's guild-event-submission-panel.jsx's twin, not this one).
//
// Under the hood this still calls submit_guild_event_submission() — the same RPC the
// tournament/writing-contest page uses — because that's the only thing that records a
// submitted_at timestamp for the 'on_time_completion' objective metric to score against
// (compute_guild_event_placements(): on-time = submitted_at <= event.end_date, scored 100,
// otherwise 0). title is left null and content is left null; word_count is sent as 0. None of
// those three matter for a reading challenge's own scoring — only that a row exists and when it
// landed — so nothing is asked of the entrant beyond the one button.
//
// Results: shown by EntrantResultStrip (guild-event-results-panels.jsx) once the event is completed; see the
// header of guild-event-submission-panel.jsx for why this panel no longer reads guild_event_results itself.
export function GuildEventReadingChallengePanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined); // undefined = loading, null = none on file
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = not yet
    const [marking, setMarking] = useState(false);
    const [error, setError] = useState(null);

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then(setSubmission).catch(() => setSubmission(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const remaining = daysUntil(event.end_date);
    const deadlinePassed = remaining != null && remaining < 0;

    const handleMarkComplete = async () => {
        setMarking(true);
        setError(null);
        try {
            await submitGuildEventSubmission(event.id, { title: null, wordCount: 0, content: null });
            load();
        } catch (e) {
            setError(e.message || 'Could not mark this complete.');
        } finally {
            setMarking(false);
        }
    };

    // The line shown while the event is open; once it is completed EntrantResultStrip shows the entrant's own result instead.
    const activeNode = approvalStatus !== 'active' || submission === undefined ? null
        : submission
            ? React.createElement("div", { style: S.successNote },
                `\u2713 Marked complete${submission.submitted_at ? ` \u2014 ${formatDate(submission.submitted_at)}` : ''}`)
            : React.createElement("div", { style: S.goldNote }, 'Not yet marked complete');


    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your progress'),

        config && config.metric === 'on_time_completion' && approvalStatus === 'active' && React.createElement("div", {
            style: { fontSize: TYPE_SCALE[11.5], color: deadlinePassed ? C.danger : C.textDim, marginBottom: 10 },
        },
            deadlinePassed
                ? `The deadline (${formatDate(event.end_date)}) has passed.`
                : event.end_date
                    ? `Finish by ${formatDate(event.end_date)}${remaining != null ? ` \u2014 ${remaining} day${remaining === 1 ? '' : 's'} left` : ''}`
                    : 'No deadline set for this challenge.'),

        config && config.weight_bps < 10000 && approvalStatus === 'active' && React.createElement("div", { style: S.softHintLoose },
            config.weight_bps <= 0
                ? 'Placement is also decided blind by a panel of Inkroot judges, outside this guild.'
                : `${config.weight_bps / 100}% on-time completion, ${100 - config.weight_bps / 100}% blind Inkroot judges.`),

        React.createElement(EntrantResultStrip, { event, activeNode }),


        error && React.createElement("div", { style: S.errorText }, error),

        // ---------- The one action: no checklist items exist server-side to check off
        // individually (there's nothing in this schema tracking, say, chapters read) — "mark
        // complete" IS the reading challenge's entire submission, matching the design brief's
        // "single 'Mark complete' action instead of a manuscript field". ----------
        approvalStatus === 'active' && !submission && React.createElement("button", {
            disabled: marking || deadlinePassed, onClick: handleMarkComplete,
            style: { ...evTapBtn(true, true), width: '100%', opacity: (marking || deadlinePassed) ? 0.5 : 1 },
        }, marking ? '\u2026' : 'Mark as complete'));
}
