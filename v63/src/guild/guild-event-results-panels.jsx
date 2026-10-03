import { S, SERIF } from './guild-styles.js';
import { C, goldA } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { computeGuildEventPlacements, fetchMyGuildEventResult, settleComputedGuildEvent } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { evBtnStyle, EventNote } from './guild-event-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// ---------------------------------------------------------------------------------------------
// Results controls for events whose winners are COMPUTED (every guild event activated since
// migration 167 has a locked judging configuration). There is no "submit results / approve results"
// step for these any more: migration 168 pays an objective event in the same call that computes it,
// migration 169 makes a judged event an Inkroot-admin payout, and migration 173 stops the hosting
// guild approving a computed row at all. The server decides who may press what and when; every
// message shown here is the server's own. The old organizer-declares / guild-approves flow only
// remains in EventCard for events created before migration 167 (no configuration row).
//
// NOT here (deliberately): excluding a judge's scores before paying. compute_guild_event_placements()
// accepts a list of judge ids for that, but nothing returns the judge list to the app yet, so the
// admin can only compute with everyone included from this screen.
// ---------------------------------------------------------------------------------------------

const rcHeadingStyle = { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textSoft, marginBottom: 6 };
const rcNoteStyle = { fontSize: TYPE_SCALE[12], color: C.textDim, lineHeight: 1.5, marginBottom: 10 };
// Look only. A 48px button (these are money actions on a phone), and one tinted strip for the status messages.
const rcBtn = (primary) => ({ ...evBtnStyle(primary), minHeight: 48, fontSize: TYPE_SCALE[13], borderRadius: RADIUS_SCALE[12] });
// config: the event's guild_event_objective_config row ({ metric, weight_bps, ... }); the caller only
// renders this once the event is completed, unsettled, and has one. canCompute = organizer, guild
// authority or Inkroot admin (the server re-checks). isAdmin = Inkroot admin. results = the event's
// current guild_event_results row, if the caller could read one.
export function ComputedResultsControls({ event, config, canCompute, isAdmin, results, onChanged }) {
    const judged = Number(config.weight_bps) < 10000;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // Derived, not seeded: `results` may still be loading when this mounts.
    const [computedNow, setComputedNow] = useState(false);
    const computed = computedNow || !!(results && results.status === 'computed');
    const [paid, setPaid] = useState(false);

    const run = async (fn, failMessage, after) => {
        setBusy(true);
        setError(null);
        try {
            await fn();
            if (after) after();
            if (onChanged) onChanged();
        } catch (e) {
            setError(e.message || failMessage);
        } finally {
            setBusy(false);
        }
    };

    if (paid) {
        return React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` } },
            React.createElement(EventNote, { tone: 'success', icon: 'trophy' }, 'Winners paid.'));
    }

    if (!judged) {
        // Judge-free / purely objective: computing IS paying. Nothing to approve afterwards.
        if (!canCompute) return null;
        return React.createElement("div", { style: S.divider },
            React.createElement("div", { style: rcHeadingStyle }, 'Results'),
            React.createElement("div", { style: rcNoteStyle },
                'Works out the placements from the entries and pays the escrowed prize to the winners straight away \u2014 there\u2019s nothing to approve afterwards.'),
            error && React.createElement("div", { style: S.errorText }, error),
            React.createElement("button", { disabled: busy, onClick: () => run(() => computeGuildEventPlacements(event.id), 'Could not work out the winners.', () => setPaid(true)), style: { ...rcBtn(true), width: '100%', opacity: busy ? 0.5 : 1 } },
                busy ? '\u2026' : 'Work out the winners & pay them'));
    }

    // Judged: Inkroot's judges scored it, so Inkroot computes and pays. The host has nothing to press.
    if (!isAdmin) {
        return React.createElement("div", { style: S.divider },
            React.createElement("div", { style: rcHeadingStyle }, 'Results'),
            React.createElement(EventNote, { tone: 'neutral', icon: 'scales' },
                'Inkroot\u2019s judges scored this event. Inkroot works out the placements and pays the winners from the escrowed prize \u2014 there\u2019s nothing for the guild to submit or approve.'));
    }
    return React.createElement("div", { style: S.divider },
        React.createElement("div", { style: rcHeadingStyle }, 'Judged results \u2014 Inkroot'),
        React.createElement("div", { style: rcNoteStyle },
            computed
                ? 'Placements are computed. Nothing has been paid yet \u2014 pay them out when you\u2019re happy with the result.'
                : 'Once enough judges have scored every entry, compute the placements. Computing does not pay anyone.'),
        error && React.createElement("div", { style: S.errorText }, error),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            React.createElement("button", { disabled: busy, onClick: () => run(() => computeGuildEventPlacements(event.id), 'Could not compute the placements.', () => setComputedNow(true)), style: { ...rcBtn(!computed), flex: 1, opacity: busy ? 0.5 : 1 } },
                busy ? '\u2026' : (computed ? 'Recompute' : 'Compute placements')),
            computed && React.createElement("button", { disabled: busy, onClick: () => run(() => settleComputedGuildEvent(event.id), 'Could not pay the winners.', () => setPaid(true)), style: { ...rcBtn(true), flex: 1, opacity: busy ? 0.5 : 1 } },
                busy ? '\u2026' : 'Pay the winners')));
}

// ---------------------------------------------------------------------------------------------
// The signed-in entrant's own result on a finished event. get_my_guild_event_result() (migration 170)
// returns a row only to someone who entered, and only once the result is final (approved and paid);
// anyone else, or an unfinished event, gets null. Same wording the quiz and giveaway panels already use.
// ---------------------------------------------------------------------------------------------
function ResultNode({ result }) {
    const won = result.place != null;
    const text = won
        ? `You won #${result.place} place${result.amountNaira != null ? ` \u2014 ${formatNaira(result.amountNaira)} is in your balance` : ''}.`
        : 'The results are in \u2014 not this time.';
    // A win gets the gold trophy card; a miss stays a quiet neutral strip.
    if (!won) return React.createElement(EventNote, { tone: 'neutral', icon: 'scroll' }, text);
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], padding: '14px 14px', borderRadius: RADIUS_SCALE[12], border: `1px solid ${goldA(0.4)}`, background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` } },
        React.createElement(InkIcon, { name: 'trophy', size: 24, color: C.goldBright }),
        React.createElement("div", { style: { fontFamily: SERIF, fontSize: TYPE_SCALE[15], lineHeight: 1.35, color: C.goldBright } }, text));
}

function useMyEventResult(event) {
    const [result, setResult] = useState(undefined); // undefined = loading, null = nothing final to show
    const finished = event.approval_status === 'completed' || event.status === 'settled';
    useEffect(() => {
        if (!finished) { setResult(null); return undefined; }
        let live = true;
        fetchMyGuildEventResult(event.id).then((r) => { if (live) setResult(r); });
        return () => { live = false; };
    }, [event.id, finished, event.status]);
    return { result, finished };
}

// Tournament entrants: the bracket panel draws its own progress, so only the final line is added under it.
export function MyEventResultLine({ event }) {
    const { result } = useMyEventResult(event);
    if (!result) return null;
    return React.createElement("div", { style: { marginTop: 10 } }, React.createElement(ResultNode, { result }));
}

// ---------------------------------------------------------------------------------------------
// One "where do I stand" strip for the writing, world-building, reading-challenge and generic submission
// panels, which each used to draw their own copy. While the event is open the panel passes its own line
// (activeNode: "Submitted", "Not marked complete yet" ...). Once it is completed this shows the entrant's
// own result, read through get_my_guild_event_result() -- the old copies read guild_event_results directly,
// which an ordinary entrant cannot do, so a winner was told "Judging in progress" above their own win.
// "Judging in progress" now only shows while no final result exists, which is the truth.
// ---------------------------------------------------------------------------------------------
export function EntrantResultStrip({ event, activeNode }) {
    const { result, finished } = useMyEventResult(event);
    if (event.approval_status === 'active') return activeNode ? React.createElement("div", { style: { marginBottom: 10 } }, activeNode) : null;
    if (!finished || result === undefined) return null;
    return React.createElement("div", { style: { marginBottom: 10 } },
        result ? React.createElement(ResultNode, { result })
            : React.createElement(EventNote, { tone: 'info', icon: 'hourglass' }, 'Judging in progress\u2026'));
}
