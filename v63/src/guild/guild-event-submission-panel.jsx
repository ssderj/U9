import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { EntrantResultStrip } from './guild-event-results-panels.jsx';
import { evTapBtn, evInputStyle, OBJECTIVE_METRIC_LABELS } from './guild-event-ui.jsx';
import { SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


function countWords(text) {
    if (!text) return 0;
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Entrant-facing submission + status + results panel for a Guild Event — see
// 121_migration_guild_event_fair_judging.sql. Meant to be rendered by EventCard
// (guild-event-card.jsx) once an entrant has a successful paid entry (myEntry.status ===
// 'success'); kept as its own file, not yet wired into EventCard, so it can be reviewed on its
// own first. It fetches its own judging config, own submission, and own results — nothing here
// is passed down that the caller would have to assemble.
//
// ---------------------------------------------------------------------------------------------
// Results: an ordinary entrant cannot read guild_event_results (49_migration_guild_event_results_approval.sql
// grants only the organizer and the treasury authority), so this panel no longer tries. Once the event is
// completed, EntrantResultStrip (guild-event-results-panels.jsx) shows the entrant's own result through
// get_my_guild_event_result() (migration 170), which returns a row only once the result is final and paid.
// The writing, world-building and reading-challenge panels use the same strip.
// ---------------------------------------------------------------------------------------------
export function GuildEventSubmissionPanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined); // undefined = loading, null = none on file
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = none yet
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [manuscriptLink, setManuscriptLink] = useState('');
    const [useLink, setUseLink] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then((s) => {
            setSubmission(s);
            if (s) {
                setTitle(s.title || '');
                const c = s.content || {};
                if (c.link) {
                    setUseLink(true);
                    setManuscriptLink(c.link);
                } else {
                    setUseLink(false);
                    setContent(c.text || '');
                }
            }
        }).catch(() => setSubmission(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    // A pasted entry is counted here for the label; a link has no text to count, and the server stores 0 words for it whatever
    // the client sends (migration 170), so the old typed-in "Word count" box did nothing and has been removed.
    const liveWordCount = useLink ? 0 : countWords(content);

    const handleSubmit = async () => {
        if (!useLink && !content.trim()) { setError('Add your entry, or switch to a manuscript link.'); return; }
        if (useLink && !manuscriptLink.trim()) { setError('Add a manuscript link, or paste your entry directly.'); return; }
        setBusy(true);
        setError(null);
        try {
            const submittedContent = useLink ? { link: manuscriptLink.trim() } : { text: content };
            await submitGuildEventSubmission(event.id, { title, wordCount: liveWordCount, content: submittedContent });
            setEditing(false);
            load();
        } catch (e) {
            setError(e.message || 'Could not submit your entry.');
        } finally {
            setBusy(false);
        }
    };

    // The line shown while the event is open; once it is completed EntrantResultStrip shows the entrant's own result instead.
    const activeNode = approvalStatus !== 'active' || submission === undefined ? null
        : submission
            ? React.createElement("div", { style: S.successNote },
                `\u2713 Submitted${submission.updated_at ? ` \u2014 last updated ${new Date(submission.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`)
            : React.createElement("div", { style: S.goldNote }, 'Not submitted yet');


    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your entry'),

        config && React.createElement("div", { style: S.softHintLoose },
            config.weight_bps >= 10000
                ? `Judged purely on ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()} \u2014 no judge panel.`
                : config.weight_bps <= 0
                    ? 'Judged blind by a panel of Inkroot judges, outside this guild.'
                    : `${config.weight_bps / 100}% ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()}, ${100 - config.weight_bps / 100}% blind Inkroot judges.`),

        React.createElement(EntrantResultStrip, { event, activeNode }),


        error && React.createElement("div", { style: S.errorText }, error),

        // ---------- Submission form ----------
        approvalStatus === 'active' && (editing || !submission)
            ? React.createElement("div", null,
                React.createElement("div", { style: { marginBottom: 8 } },
                    React.createElement("label", { style: S.capsLabel }, 'Title'),
                    React.createElement("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Give your entry a title", style: evInputStyle })),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 8 } },
                    React.createElement("button", { onClick: () => setUseLink(false), style: evTapBtn(!useLink) }, 'Paste entry'),
                    React.createElement("button", { onClick: () => setUseLink(true), style: evTapBtn(useLink) }, 'Manuscript link')),
                !useLink
                    ? React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: S.capsLabel }, `Entry \u2014 ${liveWordCount} word${liveWordCount === 1 ? '' : 's'}`),
                        React.createElement("textarea", {
                            value: content, onChange: (e) => setContent(e.target.value), rows: 8,
                            placeholder: "Paste your entry here\u2026", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' },
                        }))
                    : React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: S.capsLabel }, 'Manuscript link'),
                        React.createElement("input", { value: manuscriptLink, onChange: (e) => setManuscriptLink(e.target.value), placeholder: "https://\u2026", style: evInputStyle }),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, marginTop: 6 } }, 'Judges open this link, so make sure it can be viewed without signing in.')),
                React.createElement("div", { style: S.row8 },
                    React.createElement("button", { disabled: busy, onClick: handleSubmit, style: { ...evTapBtn(true, true), flex: 1, opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : (submission ? 'Save changes' : 'Submit entry')),
                    submission && editing && React.createElement("button", { onClick: () => setEditing(false), style: evTapBtn(false, true) }, 'Cancel')))
            : approvalStatus === 'active' && submission && React.createElement("button", { onClick: () => setEditing(true), style: evTapBtn(false) }, 'Edit entry'));
}
