import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { computeEntryFinancialBreakdown, fetchCurrentGuildEventHostingFeeNaira, fetchGuildEventFinancialAgreement, fetchGuildEventHostingFeeStatus, payGuildEventHostingFee } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { Fold } from '../shared-ui/ui-primitives.jsx';
import { evBtnStyle, evLabelStyle } from './guild-event-ui.jsx';

// One event's full display + lifecycle controls, shared between GoGuildEventsSection (a guild's
// own Treasury tab) and the Inkroot Admin screen (src/admin/inkroot-events-admin.jsx). isOwner
// here means "authorized to manage THIS specific event" — see the original comment on why that's
// computed per-event rather than just "is a guild owner" in general. Everything that actually
// moves money or changes approval_status — enterGuildEvent, settleGuildEvent,
// submitGuildEventForApproval, approveGuildEvent, etc. — is a request to a server RPC or edge
// function that re-derives and re-checks every fact itself; nothing here is trusted client-side.
// See 42_migration_guild_events.sql and 45_migration_guild_event_creation_workflow.sql.
function breakdownRow(label, value, opts = {}) {
    return React.createElement("div", { key: label, style: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: opts.last ? 'none' : `1px solid ${C.ledgerLine}` } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: opts.muted ? C.neutralSoft : C.textDim } }, label),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: opts.highlight ? C.goldBright : C.text, fontWeight: opts.highlight ? 600 : 400 } }, value));
}

// The one place the Entry Fee \u2192 Inkroot Fee \u2192 Prize Pool \u2192 Guild Share \u2192 Other
// Allocations flow is actually drawn \u2014 shared by the organizer's live create/edit preview,
// the pre-publish review, and the entrant/read-only view post-activation, so the ordering and
// the numbers behind it can never drift between those three places. `breakdown` is always the
// output of computeEntryFinancialBreakdown (lib/guild-events.js) \u2014 this component only ever
// arranges numbers that file already computed, it never computes one itself. `locked` mirrors
// the financial agreement's own `locked` column (true from the moment activateGuildEvent runs,
// per 48_migration_guild_event_financial_agreement.sql) \u2014 not a guess made here.
export function FinancialFlowDiagram({ breakdown, locked }) {
    if (!breakdown) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, fontStyle: 'italic' } },
            'Set an entry fee and a prize pool / guild share split above to see where the money goes.');
    }
    const steps = [
        { label: 'Entry Fee', value: formatNaira(breakdown.entryFeeKobo / 100) },
        { label: 'Inkroot Fee', value: `\u2212 ${formatNaira(breakdown.platformFeeKobo / 100)}` },
        { label: 'Prize Pool', value: formatNaira(breakdown.prizePoolKobo / 100), highlight: true },
        { label: 'Guild Share', value: formatNaira(breakdown.guildShareKobo / 100) },
        ...breakdown.otherAllocations.map((a) => ({ label: `Other Allocation \u2014 ${a.label}`, value: formatNaira(a.kobo / 100) })),
    ];
    return React.createElement("div", { style: S.insetPanel },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement("div", { style: { ...evLabelStyle, marginBottom: 0 } }, 'Financial structure'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], fontWeight: 600, color: locked ? C.success : C.gold } },
                locked ? 'Locked' : 'Not yet locked')),
        steps.map((s, i) => React.createElement(React.Fragment, { key: s.label },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: s.highlight ? C.goldBright : C.textDim } }, s.label),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: s.highlight ? 600 : 400, color: s.highlight ? C.goldBright : C.text } }, s.value)),
            i < steps.length - 1 && React.createElement("div", { style: { textAlign: 'center', color: C.ledgerArrow, fontSize: TYPE_SCALE[11], lineHeight: '14px' } }, '\u2193'))));
}

// The full financial picture a guild owner has to review — hosting fee, entry price, expected
// revenue, prize pool, guild share, and Inkroot's other applicable (per-entry) fee — before an
// approved event can be published. Every figure comes from a live read (current hosting fee
// rate, current platform fee %, this event's own submitted numbers) rather than anything
// hardcoded here — see 47_migration_guild_event_hosting_fee.sql on why the hosting fee in
// particular is configurable server-side, not a constant in this file. Publishing itself is
// still gated server-side too (publish_guild_event refuses without a successful payment row) —
// this panel disabling the button early is just so the owner isn't surprised by a server
// rejection after already trying to publish.
export function HostingFeePanel({ event, onPublished }) {
    const [hostingFeeNaira, setHostingFeeNaira] = useState(null);
    const [agreement, setAgreement] = useState(null);
    const [paymentStatus, setPaymentStatus] = useState(undefined); // undefined = loading
    const [paying, setPaying] = useState(false);
    const [error, setError] = useState(null);
    // Required, explicit confirmation of the financial structure before Publish is even
    // clickable \u2014 purely a client-side gate on top of what publish_guild_event() already
    // refuses server-side (no successful hosting-fee payment row); this is the organizer
    // actively acknowledging the split, not a new permission check.
    const [confirmed, setConfirmed] = useState(false);

    const loadFeeInfo = () => {
        Promise.all([
            fetchCurrentGuildEventHostingFeeNaira(),
            fetchGuildEventFinancialAgreement(event.id),
            fetchGuildEventHostingFeeStatus(event.id),
        ]).then(([fee, agr, status]) => {
            setHostingFeeNaira(fee);
            setAgreement(agr);
            setPaymentStatus(status);
        }).catch((e) => setError(e.message || 'Could not load hosting fee details.'));
    };
    useEffect(loadFeeInfo, [event.id]);

    const handlePay = async () => {
        setPaying(true);
        setError(null);
        try {
            const status = await payGuildEventHostingFee(event.id);
            if (status === 'failed') setError('Payment did not go through.');
            loadFeeInfo();
        } catch (e) {
            setError(e.message || 'Could not start checkout.');
        } finally {
            setPaying(false);
        }
    };

    if (hostingFeeNaira === null || paymentStatus === undefined) {
        return React.createElement("div", { style: { marginTop: 12, fontSize: TYPE_SCALE[11], color: C.textMuted } }, error || 'Loading hosting fee details\u2026');
    }

    const entryPriceKobo = Math.round((event.entryFeeNaira || 0) * 100);
    const breakdown = computeEntryFinancialBreakdown(entryPriceKobo, agreement);
    const paid = paymentStatus && paymentStatus.status === 'success';
    const canPublish = paid && confirmed && !!breakdown;

    return React.createElement("div", { style: S.divider },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 } }, 'Review before publishing'),
        breakdownRow('Hosting fee (Inkroot, one-time)', formatNaira(hostingFeeNaira), { highlight: true }),

        !breakdown
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginTop: 8 } }, 'Financial agreement not set \u2014 go back and finish the financial agreement section.')
            : React.createElement(React.Fragment, null,
                React.createElement(FinancialFlowDiagram, { breakdown, locked: !!agreement.locked }),
                event.participant_limit && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 6 } },
                    `Prize pool above is per entrant \u2014 up to ${event.participant_limit} entries.`)),

        error && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        // ---------- Required confirmation before publishing ----------
        // Publish stays disabled until the organizer explicitly ticks this \u2014 acknowledging
        // the exact split shown above \u2014 on top of the hosting-fee payment itself.
        breakdown && React.createElement("label", { style: { display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[6], marginTop: 12, fontSize: TYPE_SCALE[11], color: C.textDim, cursor: 'pointer' } },
            React.createElement("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked), style: { marginTop: 2 } }),
            React.createElement("span", null, 'I confirm this financial structure \u2014 the entry fee, Inkroot fee, prize pool, guild share, and any other allocations shown above. Once this event is activated, the split can never be changed.')),

        paymentStatus && paymentStatus.status === 'pending' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.gold, marginTop: 8 } }, 'Payment pending\u2026'),

        React.createElement("div", { style: { marginTop: 12 } },
            paid
                ? React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center', flexWrap: 'wrap' } },
                    React.createElement("span", { style: S.successText }, '\u2713 Hosting fee paid'),
                    React.createElement("button", { disabled: !canPublish, onClick: onPublished, style: { ...evBtnStyle(true), opacity: canPublish ? 1 : 0.5 } }, 'Publish'))
                : React.createElement("button", { disabled: paying, onClick: handlePay, style: { ...evBtnStyle(true), opacity: paying ? 0.6 : 1 } },
                    paying ? '\u2026' : `Pay hosting fee \u2014 ${formatNaira(hostingFeeNaira)}`)));
}

// The public-facing version of the same breakdown \u2014 shown to ANY viewer (not just the
// owner) once an event is visible at all (published/active/completed; see fetchGuildEvents'
// includeAllStatuses filter for why a non-owner never sees a bare draft). This is what makes
// "show participants the money distribution before payment" real: it's rendered above the Enter
// button itself, sourced from the same locked guild_event_financial_agreements row
// settle_guild_event() enforces \u2014 never a client-side guess.
export function EntryFinancialBreakdown({ event, collapsible = false }) {
    const [agreement, setAgreement] = useState(undefined); // undefined = loading, null = none on file
    // Only used when `collapsible`: both the organizer card and the public event page fold the diagram behind a one-line
    // summary (entry fee, locked or not). The public page used to show it open above the Join button; the button now
    // comes first and the full breakdown is one tap away, still before anyone pays.
    const [open, setOpen] = useState(false);
    useEffect(() => {
        let cancelled = false;
        fetchGuildEventFinancialAgreement(event.id).then((a) => { if (!cancelled) setAgreement(a); }).catch(() => setAgreement(null));
        return () => { cancelled = true; };
    }, [event.id]);

    if (agreement === undefined) return null;
    const entryPriceKobo = Math.round((event.entryFeeNaira || 0) * 100);
    const breakdown = computeEntryFinancialBreakdown(entryPriceKobo, agreement);
    if (!breakdown) return null;

    // Once the event has begun (active/completed), the agreement's own `locked` column is
    // already true \u2014 activateGuildEvent locks it server-side (48_migration_guild_event_
    // financial_agreement.sql). This just surfaces that real flag; it never decides locking
    // itself.
    const diagram = React.createElement(FinancialFlowDiagram, { breakdown, locked: !!agreement.locked });
    if (!collapsible) return React.createElement("div", { style: { marginTop: 10, marginBottom: 10 } }, diagram);
    return React.createElement(Fold, {
        icon: "scales", title: "Where the money goes", open, onToggle: () => setOpen((v) => !v), minHeight: 52, bodyGap: 10, style: { marginTop: 10, marginBottom: 10 },
        summary: `${event.entryFeeNaira ? `Entry ${formatNaira(event.entryFeeNaira)}` : 'Free entry'} \u00B7 ${agreement.locked ? 'locked' : 'can change until it opens'}`,
    }, diagram);
}
