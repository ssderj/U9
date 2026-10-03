import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { addGiveawayTicket, decideGiveawayTie, drawGuildGiveaway, fetchGiveawayTieCandidates, fetchGiveawayTieStatus, fetchMyGiveawayTickets, fetchMyGuildEventResult } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { evBtnStyle, evTapBtn, evInputStyle } from './guild-event-ui.jsx';
import { RADIUS_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { withIcon } from '../shell/ink-icon.jsx';
import { ConfirmDialog } from '../shared-ui/ui-primitives.jsx';

// ---------------------------------------------------------------------------------------------
// Giveaway — live as of migration 171 (171_migration_giveaway_backend.sql). Free tickets, one per
// tap; the SERVER enforces every rule, this file only shows the outcome:
//   - 10 taps a minute and 100 tickets a person (add_giveaway_ticket)
//   - members of the hosting guild can't enter or win (checked when tapping AND again at the draw)
//   - the winner is drawn by the server from its own random source the moment the event is completed
//     (or the hourly sweep closes it), and the escrowed prize goes straight to their withdrawable
//     balance — no guild approval step
//   - draw_method ('weighted_random' | 'highest_entries') is chosen at creation and locked once the
//     event leaves draft.
//   - highest-entries tie (migration 181): the host guild picks the winner from the tied people within 48
//     hours; after that the server picks one of them at random. Everyone sees that a tie is being decided;
//     only the host side sees the tied names and the buttons.
// A tap that the server refuses is never counted here: the number on screen is always what the
// server returned. Results are read through get_my_guild_event_result() (migration 170) because an
// ordinary entrant can't read guild_event_results directly, and only once the draw has paid out.
// ---------------------------------------------------------------------------------------------
// Display only: the server (add_giveaway_ticket, migration 171) is what actually enforces this limit.
const GIVEAWAY_TICKET_CAP = 100;

const DRAW_METHOD_LABELS = {
    weighted_random: 'Weighted random draw',
    highest_entries: 'Highest entries wins',
};


// ---------- Host side: draw method chosen at creation ----------
export function GiveawayDrawFields({ drawMethod, onChange, locked }) {
    const disabled = !!locked;
    return React.createElement("div", { style: S.insetPanel },
        React.createElement("label", { style: { ...S.capsLabel, marginBottom: 8 } }, 'How is the winner drawn?'),
        React.createElement("select", { value: drawMethod, disabled, onChange: (e) => onChange('drawMethod', e.target.value), style: { ...evInputStyle, opacity: disabled ? 0.5 : 1, marginBottom: 8 } },
            React.createElement("option", { value: "" }, 'Choose a draw method'),
            Object.entries(DRAW_METHOD_LABELS).map(([v, label]) => React.createElement("option", { key: v, value: v }, label))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginBottom: 6 } },
            drawMethod === 'weighted_random' ? 'Every ticket is one chance \u2014 more tickets, better odds, but anyone can win.'
                : drawMethod === 'highest_entries' ? 'Whoever holds the most tickets when entries close wins outright. If two or more tie, your guild picks the winner from the tied people within 48 hours \u2014 after that, one of them is picked at random.'
                    : 'Weighted random rewards every ticket a little; highest-entries rewards the biggest buyer.'),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, fontStyle: 'italic' } },
            'Locked once the event opens for entries. Members of this guild can\u2019t enter or win.'));
}

// ---------- Entrant side ----------
// Free and repeatable: one big button, each tap is one ticket. No payment, no submission.
// `canManage` (the guild owner viewing their own event) only adds a retry for a draw that failed —
// normally completing the event already draws it.
export function GuildEventGiveawayPanel({ event, myUserId, blocked, canManage, onChanged }) {
    const [tickets, setTickets] = useState(null);
    const [tapping, setTapping] = useState(false);
    const [tapError, setTapError] = useState('');
    // undefined = still loading, null = no final result to show (not drawn yet, or nothing for this person)
    const [result, setResult] = useState(undefined);
    const [drawing, setDrawing] = useState(false);
    const [drawError, setDrawError] = useState('');
    const [drawnNow, setDrawnNow] = useState(false);
    // Highest-entries tie: undefined = loading, null = no tie waiting, else { decideBy, canDecide }.
    const [tie, setTie] = useState(undefined);
    const [candidates, setCandidates] = useState([]);
    const [deciding, setDeciding] = useState(false);
    const [pendingPick, setPendingPick] = useState(null);
    const [decideError, setDecideError] = useState('');

    const approvalStatus = event.approval_status;
    const settled = event.status === 'settled';

    useEffect(() => {
        if (blocked || !myUserId) return undefined;
        let live = true;
        fetchMyGiveawayTickets(event.id).then((n) => { if (live) setTickets(n); });
        return () => { live = false; };
    }, [event.id, myUserId, blocked]);

    useEffect(() => {
        if (approvalStatus !== 'completed') { setResult(undefined); return undefined; }
        let live = true;
        fetchMyGuildEventResult(event.id).then((r) => { if (live) setResult(r); });
        return () => { live = false; };
    }, [event.id, approvalStatus, settled, drawing]);

    useEffect(() => {
        if (approvalStatus !== 'completed' || event.drawMethod === 'weighted_random') { setTie(null); return undefined; }
        let live = true;
        fetchGiveawayTieStatus(event.id).then(async (t) => {
            if (!live) return;
            setTie(t);
            if (t && t.canDecide) {
                const list = await fetchGiveawayTieCandidates(event.id);
                if (live) setCandidates(list);
            } else if (live) {
                setCandidates([]);
            }
        });
        return () => { live = false; };
    }, [event.id, event.drawMethod, approvalStatus, settled, drawing, drawnNow, deciding]);

    const canEnter = approvalStatus === 'active' && event.status === 'open' && !blocked;

    const handleTap = async () => {
        if (tapping) return;
        setTapping(true);
        setTapError('');
        try {
            setTickets(await addGiveawayTicket(event.id));
        } catch (err) {
            setTapError(err.message || 'Could not add a ticket. Try again.');
        } finally {
            setTapping(false);
        }
    };

    const handleDraw = async () => {
        setDrawing(true);
        setDrawError('');
        try {
            await drawGuildGiveaway(event.id);
            setDrawnNow(true);
            if (onChanged) onChanged();
        } catch (err) {
            setDrawError(err.message || 'Could not run the draw.');
        } finally {
            setDrawing(false);
        }
    };

    const handleDecide = (candidate) => {
        if (deciding) return;
        setPendingPick(candidate);
    };

    const confirmDecide = async () => {
        const candidate = pendingPick;
        setPendingPick(null);
        if (!candidate || deciding) return;
        setDeciding(true);
        setDecideError('');
        try {
            await decideGiveawayTie(event.id, candidate.id);
            if (onChanged) onChanged();
        } catch (err) {
            setDecideError(err.message || 'Could not record the winner.');
        } finally {
            setDeciding(false);
        }
    };

    const won = result && result.place === 1;
    const entered = (tickets || 0) > 0;
    const drawnAndPaid = result != null;

    return React.createElement("div", { className: "ik-ev", style: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, textAlign: 'center' } },
        blocked
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, fontStyle: 'italic' } }, 'Members of the hosting guild can\u2019t enter their own giveaway.')
            : React.createElement(React.Fragment, null,
                React.createElement("div", { style: { ...S.fieldLabel, textAlign: 'left' } }, 'Your entries'),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: 44, color: C.goldBright, fontWeight: 600, lineHeight: 1 } }, tickets == null ? '\u2013' : tickets),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textDim, margin: '4px 0 12px' } }, `${tickets === 1 ? 'entry' : 'entries'} \u00b7 up to ${GIVEAWAY_TICKET_CAP}`),
                canEnter && React.createElement("button", { disabled: tapping || !myUserId, onClick: handleTap, style: { ...evBtnStyle(true), width: '100%', minHeight: 56, padding: '16px 0', fontSize: TYPE_SCALE[16] || 16, opacity: tapping ? 0.6 : 1 } }, tapping ? '\u2026' : withIcon('gift', 'Tap to enter', 18)),
                canEnter && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginTop: 8 } }, 'Free \u2014 one tap, one entry.'),
                tapError && React.createElement("div", { role: "alert", style: { fontSize: TYPE_SCALE[11.5], color: C.danger, marginTop: 8 } }, tapError)),

        won && React.createElement("div", { style: { marginTop: 12, fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: C.goldBright } },
            withIcon('trophy', 'You won!' + (result.amountNaira != null ? ` ${formatNaira(result.amountNaira)} is in your withdrawable balance.` : ''), 16)),
        drawnAndPaid && !won && entered && React.createElement("div", { style: { marginTop: 12, fontSize: TYPE_SCALE[11.5], color: C.textSoft } }, 'The draw is done \u2014 not this time.'),
        approvalStatus === 'completed' && !drawnAndPaid && !settled && !tie && React.createElement("div", { style: { marginTop: 12, fontSize: TYPE_SCALE[11.5], color: C.info } }, 'Draw pending\u2026'),

        // Highest-entries tie: everyone sees it is being decided; the host side gets the tied names to pick from.
        approvalStatus === 'completed' && !drawnAndPaid && !settled && tie && React.createElement("div", { style: { marginTop: 12, textAlign: 'left', background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], padding: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.goldBright, marginBottom: 4 } }, 'It\u2019s a tie for the most entries'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textDim, marginBottom: tie.canDecide ? 8 : 0 } },
                tie.canDecide
                    ? `Pick the winner from the people tied below by ${new Date(tie.decideBy).toLocaleString()}. If you don\u2019t, one of them is picked at random.`
                    : `The hosting guild has until ${new Date(tie.decideBy).toLocaleString()} to pick the winner from the people tied. If they don\u2019t, one of them is picked at random.`),
            tie.canDecide && candidates.map((c) => React.createElement("button", { key: c.id, disabled: deciding, onClick: () => handleDecide(c), style: { ...evTapBtn(false), display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, opacity: deciding ? 0.6 : 1 } }, `${c.name} \u2014 ${c.tickets} ${c.tickets === 1 ? 'entry' : 'entries'}`)),
            decideError && React.createElement("div", { role: "alert", style: { fontSize: TYPE_SCALE[11.5], color: C.danger, marginTop: 6 } }, decideError)),

        canManage && approvalStatus === 'completed' && !settled && !drawnNow && React.createElement("div", { style: { marginTop: 12 } },
            React.createElement("button", { disabled: drawing, onClick: handleDraw, style: { ...evTapBtn(false), opacity: drawing ? 0.6 : 1 } }, drawing ? '\u2026' : 'Run the draw'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginTop: 6 } }, 'Completing the event draws it automatically. Use this only if that draw failed.'),
            drawError && React.createElement("div", { role: "alert", style: { fontSize: TYPE_SCALE[11.5], color: C.danger, marginTop: 6 } }, drawError)),

        pendingPick && React.createElement(ConfirmDialog, {
            message: `Pick ${pendingPick.name} as the winner? The prize is paid to them straight away and this can't be undone.`,
            confirmLabel: 'Pick winner', onCancel: () => setPendingPick(null), onConfirm: confirmDecide,
        }));
}
