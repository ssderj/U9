import { S } from './guild-styles.js';
import { C, goldA, dangerA } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import { activateGuildEvent, adminCancelGuildEventDispute, approveGuildEventResults, cancelGuildEvent, closeGuildEvent, completeGuildEvent, depositGuildEventPrizeEscrow, enterGuildEvent, enterOfficialEventFree, fetchGuildEventEntryCount, fetchGuildEventEscrowStatus, fetchGuildEventFinancialAgreement, fetchGuildEventObjectiveConfig, fetchGuildEventResults, fetchMyGuildEventEntry, publishGuildEvent, rejectGuildEventResults, settleGuildEvent, submitGuildEventForApproval, submitGuildEventResults } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { Fold } from '../shared-ui/ui-primitives.jsx';
import { GuildEventSubmissionPanel } from './guild-event-submission-panel.jsx';
import { GuildEventReadingChallengePanel } from './guild-event-reading-challenge-panel.jsx';
import { GuildEventWritingPanel } from './guild-event-writing-panel.jsx';
import { GuildEventWorldBuildingPanel } from './guild-event-world-building-panel.jsx';
import { GuildEventGiveawayPanel } from './guild-event-giveaway-panel.jsx';
import { GuildEventQuizPanel, QuizSuggestPanel, IconText } from './guild-event-quiz-panel.jsx';
import { ComputedResultsControls, MyEventResultLine } from './guild-event-results-panels.jsx';
import { GuildEventTournamentPanel, TournamentReviewPanel } from './guild-event-tournament-panel.jsx';
import { withIcon } from '../shell/ink-icon.jsx';
import { EVENT_APPROVAL_COLORS, EVENT_APPROVAL_LABELS, EventHowItWorks, EventNote, EventTypeBadge, RESULTS_STATUS_COLORS, RESULTS_STATUS_LABELS, entryCopyFor, evBtnStyle, evInputStyle, formatEventDate } from './guild-event-ui.jsx';
import { EntryFinancialBreakdown, HostingFeePanel } from './guild-event-finance.jsx';

// ---------- Look only (no behaviour): shared bits for the entrant-facing states below ----------
// cardBtn is evBtnStyle with a 44px minimum height. It is local because evBtnStyle is shared by every event
// screen; the organizer buttons on this card were the ones that fell under a comfortable tap size on a phone.
const cardBtn = (primary) => ({ ...evBtnStyle(primary), minHeight: 44 });
const cardSerif = "'Fraunces', Georgia, serif";

// embedded: the public event detail page (guild-event-detail-screen.jsx) already draws the cover, title, stats,
// description and rules itself, so it passes embedded to get ONLY the entrant part of this card (entry state,
// the quiz / tournament / giveaway / submission panels, the caller's own result). Every existing caller leaves
// it unset and gets exactly the card it always did.
// headerless: the guild's own event page (guild-events-section.jsx) draws the same poster as the public page (cover,
// title, stats, description, how it works, rules), so it passes headerless to skip just those header parts while
// keeping everything an organizer needs (lifecycle controls, results, tournament review, cancel). Like embedded,
// it also puts the entry state first, above the folded money breakdown.
export function EventCard({ event, isOwner, members, onChanged, onEdit, canApprove, myUserId, isAdmin, embedded, headerless }) {
    const [myEntry, setMyEntry] = useState(undefined); // undefined = loading, null = no entry
    const [entering, setEntering] = useState(false);
    const [error, setError] = useState(null);
    const [settling, setSettling] = useState(false);
    const [showSettle, setShowSettle] = useState(false);
    const [winnerRows, setWinnerRows] = useState([{ memberId: '', sharePct: '' }]);
    const [lifecycleBusy, setLifecycleBusy] = useState(false);
    const [entryCount, setEntryCount] = useState(null);
    const [settleAgreement, setSettleAgreement] = useState(null);
    // The organizer-facing card keeps the essentials on show and folds the rest (see the Rules and More actions rows below).
    const [rulesOpen, setRulesOpen] = useState(false);
    const [moreOpen, setMoreOpen] = useState(false);

    // ---------- Guaranteed prize escrow (see 108_migration_guild_event_prize_escrow.sql) ----------
    // escrowStatus: undefined = loading/not applicable, null = declared but not yet deposited,
    // { depositedAt, amountNaira } once deposit_guild_event_prize_escrow has succeeded.
    const [escrowStatus, setEscrowStatus] = useState(undefined);
    const [depositingEscrow, setDepositingEscrow] = useState(false);
    const loadEscrowStatus = () => {
        if (event.host !== 'guild' || !event.guaranteedPrizeNaira) { setEscrowStatus(undefined); return; }
        fetchGuildEventEscrowStatus(event.guild_id, event.id).then(setEscrowStatus).catch(() => setEscrowStatus(null));
    };
    useEffect(loadEscrowStatus, [event.id, event.guaranteedPrizeNaira]);
    const handleDepositEscrow = async () => {
        setDepositingEscrow(true);
        setError(null);
        try {
            await depositGuildEventPrizeEscrow(event.guild_id, event.id);
            loadEscrowStatus();
        } catch (e) {
            setError(e.message || 'Could not deposit the guaranteed prize into escrow.');
        } finally {
            setDepositingEscrow(false);
        }
    };

    // ---------- Owner cancellation (see 108_migration_guild_event_prize_escrow.sql) ----------
    // Only succeeds server-side while no entrant has paid (or has a payment still in flight) and
    // the event isn't already settled/cancelled — this button is offered any time those two
    // aren't already visibly true, and lets the server's own refusal message explain the rest.
    //
    // The lifecycle handlers below (this one, runLifecycle, handleClose, handleSettle) all also
    // refetch in their catch. The server commits before it answers, so a response lost on the way
    // back (a dropped connection, a timeout) reads as a failure here while the action actually went
    // through — and without a refetch this card kept showing the old state, offering a Cancel /
    // Settle / Close button that could only be refused now (audit finding #22). A refetch after a
    // genuine refusal is harmless: it just returns the unchanged state, and the error message stays
    // because the card stays mounted (every parent refreshes in place — see loadGuildEvents in
    // inkroot-events-admin.jsx).
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const handleCancelEvent = async () => {
        setCancelling(true);
        setError(null);
        try {
            await cancelGuildEvent(event.guild_id, event.id);
            setShowCancelConfirm(false);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not cancel this event.');
            onChanged();
        } finally {
            setCancelling(false);
        }
    };

    // ---------- Inkroot-admin force-cancel for a genuine dispute ----------
    const [showAdminCancel, setShowAdminCancel] = useState(false);
    const [adminCancelReason, setAdminCancelReason] = useState('');
    const [adminCancelBusy, setAdminCancelBusy] = useState(false);
    const [adminCancelError, setAdminCancelError] = useState(null);
    const handleAdminCancel = async () => {
        if (!adminCancelReason.trim()) { setAdminCancelError('Give a reason for the record.'); return; }
        setAdminCancelBusy(true);
        setAdminCancelError(null);
        try {
            await adminCancelGuildEventDispute(event.id, adminCancelReason.trim());
            setShowAdminCancel(false);
            setAdminCancelReason('');
            onChanged();
        } catch (e) {
            setAdminCancelError(e.message || 'Could not cancel this event.');
        } finally {
            setAdminCancelBusy(false);
        }
    };

    // ---------- Guild Event results: organizer submission + required approval ----------
    // See 49_migration_guild_event_results_approval.sql. `results` is this event's current
    // proposal (undefined = loading, null = none submitted). isOrganizer/canApprove gate which
    // controls render; every write still re-derives and re-checks organizer/authority
    // server-side regardless of what this component believes.
    const [results, setResults] = useState(undefined);
    const [showSubmitResults, setShowSubmitResults] = useState(false);
    const [resultRows, setResultRows] = useState([{ place: '1', memberId: '', sharePct: '' }]);
    const [resultsBusy, setResultsBusy] = useState(false);
    const [resultsError, setResultsError] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [showReject, setShowReject] = useState(false);
    const isOrganizer = event.host === 'guild' && myUserId != null && event.organizer_id === myUserId;
    // Migration 185: an official Inkroot quiz or tournament. Open to everyone, free unless the admin set a fee,
    // paid from Inkroot's prize reserve; Inkroot admins can't play it (the server refuses them).
    const isOfficialGame = event.host === 'inkroot' && ['reading_challenge', 'tournament'].includes(event.event_type);

    // The event's locked judging configuration, read once it's completed. undefined = loading (or the
    // read failed: nothing results-related is shown then, never a guess), null = none on file, which
    // only an event created before migration 167 can be. That is what decides which results flow shows:
    // computed (every event with a config) or the legacy organizer-submits / guild-approves one.
    const [objConfig, setObjConfig] = useState(undefined);
    useEffect(() => {
        if (event.host !== 'guild' || event.approval_status !== 'completed') { setObjConfig(undefined); return undefined; }
        let live = true;
        fetchGuildEventObjectiveConfig(event.id).then((c) => { if (live) setObjConfig(c || null); }).catch(() => { if (live) setObjConfig(undefined); });
        return () => { live = false; };
    }, [event.id, event.approval_status]);

    const loadResults = () => {
        if (event.host !== 'guild') return;
        fetchGuildEventResults(event.id).then(setResults).catch(() => setResults(null));
    };
    useEffect(() => {
        if (event.host !== 'guild' || !['completed', 'active'].includes(event.approval_status)) { setResults(null); return; }
        loadResults();
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [event.id, event.approval_status]);

    // Prefills from the event's own (informational, unenforced) prize_structure the first time
    // the submit form is opened with nothing already proposed; otherwise reopens whatever was
    // last submitted (so revising after a rejection starts from the rejected proposal, not blank).
    const openSubmitResults = () => {
        if (results && results.placements && results.placements.length > 0) {
            setResultRows(results.placements.map((p) => ({ place: String(p.place || ''), memberId: p.contributorId || '', sharePct: p.sharePct != null ? String(p.sharePct) : '' })));
        } else if (event.prize_structure && event.prize_structure.length > 0) {
            setResultRows(event.prize_structure.map((p) => ({ place: String(p.place || ''), memberId: '', sharePct: p.share_pct != null ? String(p.share_pct) : '' })));
        } else {
            setResultRows([{ place: '1', memberId: '', sharePct: '' }]);
        }
        setResultsError(null);
        setShowSubmitResults(true);
    };

    const handleSubmitResults = async () => {
        const placements = resultRows
            .filter((r) => r.place && r.memberId && Number(r.sharePct) > 0)
            .map((r) => ({ contributorId: r.memberId, place: r.place, sharePct: r.sharePct }));
        if (placements.length === 0) { setResultsError('Add at least one winner.'); return; }
        setResultsBusy(true);
        setResultsError(null);
        try {
            const saved = await submitGuildEventResults(event.guild_id, event.id, placements);
            setResults(saved);
            setShowSubmitResults(false);
        } catch (e) {
            setResultsError(e.message || 'Could not submit these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    const handleApproveResults = async () => {
        setResultsBusy(true);
        setResultsError(null);
        try {
            await approveGuildEventResults(event.id);
            loadResults();
            onChanged();
        } catch (e) {
            setResultsError(e.message || 'Could not approve these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    const handleRejectResults = async () => {
        setResultsBusy(true);
        setResultsError(null);
        try {
            await rejectGuildEventResults(event.id, rejectReason);
            setShowReject(false);
            setRejectReason('');
            loadResults();
        } catch (e) {
            setResultsError(e.message || 'Could not reject these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    // Loaded once settling starts, so the owner can see (and this component can enforce
    // client-side, matching what settle_guild_event() will enforce server-side regardless)
    // exactly what winner shares must add up to \u2014 the locked prize_pool_bps, not just "no
    // more than 100%". See 48_migration_guild_event_financial_agreement.sql.
    useEffect(() => {
        if (!showSettle || event.host !== 'guild') return;
        fetchGuildEventFinancialAgreement(event.id).then(setSettleAgreement).catch(() => setSettleAgreement(null));
    }, [showSettle, event.id, event.host]);

    useEffect(() => {
        // Also checked once 'completed' (not just 'active') so a refund landing after entries
        // closed \u2014 still possible, a Paystack dispute isn't tied to the event being open \u2014
        // is visible here too.
        if ((event.host !== 'guild' && !isOfficialGame) || !['active', 'completed'].includes(event.approval_status)) return;
        fetchMyGuildEventEntry(event.id).then(setMyEntry).catch(() => setMyEntry(null));
    }, [event.id, event.approval_status, isOfficialGame]);

    // Live "X / limit entered" — only worth fetching when there's a limit to check against.
    // Anyone can call this (see 46_migration_guild_event_entry_count.sql), not just the owner.
    useEffect(() => {
        if ((event.host !== 'guild' && !isOfficialGame) || event.participant_limit == null) return;
        fetchGuildEventEntryCount(event.id).then(setEntryCount).catch(() => {});
    }, [event.id, event.participant_limit, myEntry, isOfficialGame]);

    const handleEnter = async () => {
        setEntering(true);
        setError(null);
        try {
            const status = (isOfficialGame && event.entryFeeNaira == null)
                ? await enterOfficialEventFree(event.id)
                : await enterGuildEvent(event.id);
            if (status === 'failed') setError('Payment did not go through.');
            else setMyEntry({ status });
        } catch (e) {
            setError(e.message || 'Could not start checkout.');
        } finally {
            setEntering(false);
        }
    };

    // `closing` stops a second tap while the first is still in flight — with a slow or lost response
    // the button used to look untouched and could be tapped again and again.
    const [closing, setClosing] = useState(false);
    const handleClose = async () => {
        setClosing(true);
        setError(null);
        try { await closeGuildEvent(event.guild_id, event.id); onChanged(); }
        catch (e) { setError(e.message || 'Could not close entries.'); onChanged(); }
        finally { setClosing(false); }
    };

    const runLifecycle = async (fn) => {
        setLifecycleBusy(true);
        setError(null);
        try {
            await fn(event.guild_id, event.id);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not update this event.');
            onChanged();
        } finally {
            setLifecycleBusy(false);
        }
    };

    const totalSharePct = winnerRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);
    // For a host='guild' event, winner shares must add up to EXACTLY the locked prize pool
    // percentage \u2014 settle_guild_event() refuses anything else server-side (see the
    // migration). host='inkroot' has no agreement to match, so any total up to 100% is fine,
    // same as before this migration.
    const requiredSharePct = event.host === 'guild' && settleAgreement ? settleAgreement.prize_pool_bps / 100 : null;
    const shareTargetMet = requiredSharePct == null || Math.round(totalSharePct * 100) === Math.round(requiredSharePct * 100);
    const handleSettle = async () => {
        const shares = winnerRows
            .filter((r) => r.memberId && Number(r.sharePct) > 0)
            .map((r) => ({ contributorId: r.memberId, shareBps: Math.round(Number(r.sharePct) * 100) }));
        if (shares.length === 0) { setError('Add at least one winner.'); return; }
        if (!shareTargetMet) { setError(`Winner shares must add up to exactly ${requiredSharePct}% \u2014 the locked prize pool.`); return; }
        setSettling(true);
        setError(null);
        try {
            await settleGuildEvent(event.guild_id, event.id, shares);
            setShowSettle(false);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not settle this event.');
            onChanged();
        } finally {
            setSettling(false);
        }
    };

    const approvalStatus = event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
    const dateRange = [formatEventDate(event.start_date), formatEventDate(event.end_date)].filter(Boolean).join(' \u2014 ');

    // ---------- Entrant-facing state (Payment pending / Event full / Registration successful /
    // Refund / Event cancelled) ----------
    // One place these six states are decided, all from real fields already fetched above \u2014
    // myEntry.status comes straight from guild_event_entries (including 'refunded', which
    // paystack-webhook sets on a Paystack refund/dispute \u2014 see
    // 50_migration_economy_security_audit.sql), never guessed here.
    const isFull = event.participant_limit != null && entryCount != null && entryCount >= event.participant_limit;
    // 'cancelled' is not a value guild_events.status or approval_status can hold today \u2014 see
    // 45_migration_guild_event_creation_workflow.sql's own check constraint \u2014 so this branch
    // has no live path to it. It's kept, using the same string other status columns in this app
    // already use for the concept (e.g. guild_treasury_spend_requests.status), so the UI needs no
    // further changes the day a cancellation path is actually added server-side.
    let entryStateNode = null;
    if (event.status === 'cancelled') {
        entryStateNode = React.createElement(EventNote, { tone: 'danger', icon: 'alert' },
            event.cancellation_reason ? `This event was cancelled: ${event.cancellation_reason}` : 'This event has been cancelled.');
    } else if (myEntry === undefined) {
        entryStateNode = null; // still loading
    } else if (myEntry && myEntry.status === 'success') {
        entryStateNode = React.createElement(EventNote, { tone: 'success', icon: 'check' }, entryCopyFor(event.event_type).done);
    } else if (myEntry && myEntry.status === 'refunded') {
        // Can arrive any time after a success \u2014 a Paystack refund or dispute isn't tied to
        // the event still being open \u2014 so this isn't gated on approvalStatus/event.status
        // the way the Enter button below is.
        entryStateNode = React.createElement(EventNote, { tone: 'info', icon: 'restore' }, 'Refunded \u2014 your entry fee was returned');
    } else if (myEntry && myEntry.status === 'pending') {
        // Production-readiness audit: a cancelled or abandoned checkout leaves the entry 'pending'
        // (nothing ever marks it failed), and this branch used to offer nothing but the text —
        // so the entrant could never pay again. While entries are still open, offer a retry;
        // create_guild_event_entry_locked (migration 104) re-uses this same pending entry for it.
        const canRetryEntry = approvalStatus === 'active' && event.status === 'open';
        entryStateNode = React.createElement(EventNote, { tone: 'gold', icon: 'hourglass' },
            React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("span", null, 'Payment pending\u2026'),
                canRetryEntry && React.createElement("button", { disabled: entering, onClick: handleEnter, style: { ...cardBtn(true), opacity: entering ? 0.6 : 1 } }, entering ? '\u2026' : 'Try payment again')));
    } else if (approvalStatus === 'active' && event.status === 'open') {
        // No entry yet, or a previous attempt failed \u2014 either way, still enterable while
        // entries are actually open.
        // Giveaway spec: members of the hosting guild can't enter (or win) their own guild's
        // giveaway. This card is only a courtesy — add_giveaway_ticket() and draw_guild_giveaway()
        // (migration 171) refuse a hosting-guild member themselves, so a direct RPC call gets nowhere.
        const isHostGuildMemberOfGiveaway = event.host === 'guild' && event.event_type === 'giveaway'
            && myUserId != null && (members || []).some((m) => m.user_id === myUserId);
        entryStateNode = isFull
            ? React.createElement(EventNote, { tone: 'neutral', icon: 'lock' }, 'This event is full.')
            : isHostGuildMemberOfGiveaway
                ? React.createElement(EventNote, { tone: 'neutral', icon: 'shield' }, 'Members of the hosting guild can\u2019t enter their own giveaway.')
                : (isOfficialGame && isAdmin)
                    ? React.createElement(EventNote, { tone: 'neutral', icon: 'shield' }, 'Inkroot admins can\u2019t play official events.')
                    : React.createElement("button", { disabled: entering, onClick: handleEnter, style: { ...evBtnStyle(true), width: '100%', minHeight: 52, fontSize: TYPE_SCALE[13], borderRadius: RADIUS_SCALE[12], opacity: entering ? 0.6 : 1 } }, entering ? '\u2026' : `${entryCopyFor(event.event_type).cta} \u2014 ${(isOfficialGame && event.entryFeeNaira == null) ? 'Free' : formatNaira(event.entryFeeNaira)}`);
    }

    // Giveaway entry is free and repeatable \u2014 no checkout, no "you're in" state. The tap panel below
    // is the whole entry experience, so the paid-entry button/confirmation is dropped for it.
    const isGuildGiveaway = event.host === 'guild' && event.event_type === 'giveaway';
    // Migration 172: a set-up quiz is ranked and paid by compute_guild_event_placements(), never by a
    // proposed-then-approved result, so the manual results controls below stay off it.
    const isGuildQuiz = (event.host === 'guild' || isOfficialGame) && event.event_type === 'reading_challenge' && !!event.quizTimeLimitSeconds;
    if (isGuildGiveaway && event.status !== 'cancelled') entryStateNode = null;
    const approvalColor = EVENT_APPROVAL_COLORS[approvalStatus] || C.gold;
    // Drawn once, placed by `embedded` below: after the money breakdown on the guild's own card, before it on the public page.
    const entryBlock = (event.host === 'guild' || isOfficialGame) && ['active', 'completed'].includes(approvalStatus) && entryStateNode && React.createElement("div", { style: { marginTop: 10 } }, entryStateNode);
    return React.createElement("div", { id: `gev-event-${event.id}`, className: "gev-poster-card", style: { position: 'relative', background: `linear-gradient(160deg, ${C.posterTop}, ${C.posterBottom} 65%)`, border: `1px solid ${goldA(0.22)}`, borderRadius: RADIUS_SCALE[13], padding: '16px 15px 14px', marginBottom: 10 } },
        React.createElement("style", null, `
            /* An official-notice seal on every organizer-facing event card too, so the guild's own
               management view reads as the same herald posting a reader sees, not a plain admin
               row \u2014 see guild-event-detail-screen.jsx's .ged-seal for the reader-facing twin. */
            .gev-seal-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 7px;border-radius:100px;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;flex-shrink:0;}
        `),
        !embedded && !headerless && event.cover_image_url && React.createElement("img", { src: event.cover_image_url, alt: "", style: { width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], marginBottom: 10 } }),

        !embedded && !headerless && React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: cardSerif, fontSize: TYPE_SCALE[17], lineHeight: 1.25, color: C.textStrong, fontWeight: 600 } }, event.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, marginTop: 3 } },
                    event.host === 'inkroot' ? `Inkroot cash prize \u2014 ${formatNaira(event.cashPrizeNaira)}${isOfficialGame ? (event.entryFeeNaira == null ? ' \u2014 free entry' : ` \u2014 entry ${formatNaira(event.entryFeeNaira)}`) : ''}` : (event.event_type === 'giveaway' ? 'Free entry' : `Entry fee \u2014 ${formatNaira(event.entryFeeNaira)}`)),
                event.event_type && React.createElement(EventTypeBadge, { eventType: event.event_type })),
            React.createElement("div", { className: "gev-seal-badge", style: { color: approvalColor, background: `${approvalColor}1A`, border: `1px solid ${approvalColor}55` } },
                withIcon('scales', EVENT_APPROVAL_LABELS[approvalStatus] || approvalStatus, 12))),

        // At a glance: the four facts people look for first, read from fields this card already has (no new fetch, no
        // computed money). Replaces the two small date / limit lines that used to sit under the title.
        !embedded && !headerless && React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: SPACE_SCALE[8], marginTop: 12 } },
            [
                // Only when the fee is actually known: a giveaway and a fee-less official game are free; otherwise the stored fee.
                (event.entryFeeNaira != null || event.event_type === 'giveaway' || isOfficialGame) && { label: 'Entry', value: event.event_type === 'giveaway' || event.entryFeeNaira == null ? 'Free' : formatNaira(event.entryFeeNaira) },
                dateRange && { label: 'Dates', value: dateRange },
                event.participant_limit && {
                    label: 'Entered',
                    value: entryCount != null ? `${entryCount} / ${event.participant_limit}${entryCount >= event.participant_limit ? ' \u2014 full' : ''}` : `Limit ${event.participant_limit}`,
                    warn: entryCount != null && entryCount >= event.participant_limit,
                    fill: entryCount != null ? Math.max(0, Math.min(1, entryCount / event.participant_limit)) : null,
                },
                event.host === 'guild' && event.guaranteedPrizeNaira && { label: 'Guaranteed prize', value: formatNaira(event.guaranteedPrizeNaira) },
            ].filter(Boolean).map((st) => React.createElement("div", { key: st.label, style: { background: C.panel, border: `1px solid ${C.statBorder}`, borderRadius: RADIUS_SCALE[8], padding: '8px 10px', minWidth: 0 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' } }, st.label),
                React.createElement("div", { style: { fontFamily: cardSerif, fontSize: TYPE_SCALE[13], color: st.warn ? C.danger : C.text, marginTop: 2, overflowWrap: 'anywhere' } }, st.value),
                st.fill != null && React.createElement("div", { "aria-hidden": "true", style: { height: 4, marginTop: 6, borderRadius: RADIUS_SCALE[100], background: C.border, overflow: 'hidden' } },
                    React.createElement("div", { style: { height: '100%', width: `${st.fill * 100}%`, background: st.warn ? C.danger : C.gold, transition: 'width var(--ink-dur) var(--ink-ease)' } }))))),

        !embedded && !headerless && event.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textDim, marginTop: 8, whiteSpace: 'pre-wrap' } }, event.description),
        !embedded && !headerless && React.createElement(EventHowItWorks, { event }),
        !embedded && !headerless && event.rules && React.createElement(Fold, { icon: "scroll", title: "Rules", summary: "Eligibility, format and judging", open: rulesOpen, onToggle: () => setRulesOpen((v) => !v), minHeight: 52, bodyGap: 10, style: { marginTop: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textDim, whiteSpace: 'pre-wrap', lineHeight: 1.6 } }, event.rules)),

        approvalStatus === 'rejected' && event.rejection_reason && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginTop: 8, fontStyle: 'italic' } }, `Rejected \u2014 ${event.rejection_reason}`),

        error && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        // ---------- Reader-facing entry (only once the event is genuinely open) ----------
        // The money breakdown is shown to every visible guild-hosted event, not just while it's
        // open for entries \u2014 someone deciding whether to wait for activation should be able
        // to see the same locked commitment a currently-active event's entrants see.
        // Public event page (embedded): the entry state - the Join button, or where the entrant stands - comes first, so
        // joining is never pushed below a table of numbers. The breakdown follows, folded behind a one-line summary that
        // still states the entry fee and whether the split is locked; the Join button itself names the fee too.
        (embedded || headerless) && entryBlock,
        event.host === 'guild' && React.createElement(EntryFinancialBreakdown, { event, collapsible: true }),

        // ---------- Guaranteed prize escrow ----------
        // Visible to every viewer once an organizer has declared one (it's a promise being made
        // to entrants, same as the financial breakdown above); the deposit control itself is
        // owner-only, and only useful before the event is actually activated.
        event.host === 'guild' && event.guaranteedPrizeNaira && React.createElement("div", { style: { marginTop: 10, marginBottom: 10, padding: '8px 10px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8] } },
            React.createElement("div", { style: S.goldNoteBold }, withIcon('lock', `Guaranteed prize \u2014 ${formatNaira(event.guaranteedPrizeNaira)}`, 13)),
            isOwner && escrowStatus !== undefined && React.createElement("div", { style: { marginTop: 6 } },
                escrowStatus
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.success } },
                        React.createElement(IconText, { icon: 'check', size: 12, strokeWidth: 2.4, gap: 5 }, `Escrowed${formatEventDate(escrowStatus.depositedAt) ? ` \u2014 ${formatEventDate(escrowStatus.depositedAt)}` : ''}`))
                    : ['draft', 'pending_approval', 'approved', 'published'].includes(approvalStatus)
                        ? React.createElement("button", { disabled: depositingEscrow, onClick: handleDepositEscrow, style: { ...cardBtn(true), opacity: depositingEscrow ? 0.5 : 1 } },
                            depositingEscrow ? '\u2026' : `Deposit ${formatNaira(event.guaranteedPrizeNaira)} into escrow`)
                        : React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.danger } }, 'Not escrowed \u2014 this event cannot open for entries until it is.'))),

        // Event completed \u2014 shown to every viewer once entries have stopped, distinct from
        // the approval-status badge above (which already says "Completed") in that this tells a
        // reader specifically whether payouts have happened yet.
        event.host === 'guild' && approvalStatus === 'completed' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.success, marginTop: 10 } },
            event.status === 'settled' ? 'Event completed \u2014 prizes have been paid out.' : 'Event completed \u2014 awaiting prize settlement.'),

        // On the public event page (embedded) the entry state is drawn higher up, above the money breakdown.
        !(embedded || headerless) && entryBlock,

        // ---------- Entrant submission / progress / results page (see
        // guild-event-submission-panel.jsx, guild-event-reading-challenge-panel.jsx,
        // guild-event-writing-panel.jsx, and guild-event-world-building-panel.jsx for what each
        // renders and the results-reveal gap they all carry — RLS on guild_event_results has no
        // entrant read policy yet, so the placement reveal inside these only lights up for
        // someone RLS does let read that row today). Reading Challenge gets the lighter
        // mark-complete page, Writing Contest gets the word-range-aware page, and World-Building
        // (event_type === 'workshop' — see EVENT_TYPE_LABELS' own comment) gets the World Bible
        // picker, per the redesign spec; Tournament still gets the original generic
        // submission page until its own panel is built. A Giveaway has no paid entry and no submission —
        // it gets the tap-for-tickets panel below (migration 171). Only rendered once there's an actual
        // paid entry to attach it to. ----------
        isGuildGiveaway && event.status !== 'cancelled' && ['active', 'completed'].includes(approvalStatus)
            && React.createElement(GuildEventGiveawayPanel, {
                event, myUserId, canManage: !!isOwner, onChanged,
                blocked: myUserId != null && (members || []).some((m) => m.user_id === myUserId),
            }),

        // ---------- Quiz: members of the hosting guild can suggest questions while the set can still change
        // (the host reviews; migration 172). The host writes theirs in the event form. ----------
        // (Migration 176: a tournament draws from the same bank, so its members can suggest too.)
        event.host === 'guild' && ((event.event_type === 'reading_challenge' && event.quizTimeLimitSeconds) || event.event_type === 'tournament') && !isOwner
            && ['published', 'approved'].includes(approvalStatus)
            && myUserId != null && (members || []).some((m) => m.user_id === myUserId)
            && React.createElement(QuizSuggestPanel, { event, noun: event.event_type === 'tournament' ? 'tournament' : 'quiz' }),

        (event.host === 'guild' || isOfficialGame) && !isGuildGiveaway && myEntry && myEntry.status === 'success' && ['active', 'completed'].includes(approvalStatus)
            && (event.event_type === 'tournament'
                // Migration 176: the bracket panel reads its own state from the server (get_my_tournament_state).
                ? React.createElement(GuildEventTournamentPanel, { event, myUserId, hasPaidEntry: true })
                : event.event_type === 'reading_challenge'
                // Quiz when the host set it up (migration 172: quizTimeLimitSeconds); a reading challenge
                // saved before quizzes existed keeps the original mark-complete page, unchanged.
                ? (event.quizTimeLimitSeconds
                    ? React.createElement(GuildEventQuizPanel, { event, myUserId, hasPaidEntry: true })
                    : React.createElement(GuildEventReadingChallengePanel, { event, myUserId, hasPaidEntry: true }))
                : event.event_type === 'writing_contest'
                    ? React.createElement(GuildEventWritingPanel, { event, myUserId, hasPaidEntry: true })
                    : event.event_type === 'workshop'
                        ? React.createElement(GuildEventWorldBuildingPanel, { event, myUserId, hasPaidEntry: true })
                        : React.createElement(GuildEventSubmissionPanel, { event, myUserId, hasPaidEntry: true })),

        // Migration 176: tab-switch flags for the host and Inkroot, to look at before the winners are worked out.
        (event.host === 'guild' || isOfficialGame) && event.event_type === 'tournament' && !embedded && (isOwner || isAdmin) && ['active', 'completed'].includes(approvalStatus)
            && React.createElement(TournamentReviewPanel, { event }),

        // The entrant's own result once the event is finished (migration 170). Quiz, giveaway, writing, world-building,
        // reading-challenge and generic submission panels show theirs themselves (EntrantResultStrip); only the
        // tournament panel leaves it to this line.
        (event.host === 'guild' || isOfficialGame) && event.event_type === 'tournament' && myEntry && myEntry.status === 'success' && approvalStatus === 'completed'
            && React.createElement(MyEventResultLine, { event }),

        // ---------- Owner cancellation ----------
        // Offered any time the event isn't already settled/cancelled; the server is the one that
        // actually refuses once a paid (or still-processing) entrant exists, so this doesn't try
        // to duplicate that check client-side.
        // ---------- More actions ----------
        // Cancelling is rare and destructive, so the owner's Cancel event and the admin's Force-cancel share one closed
        // row instead of sitting open under every card. The two blocks inside are unchanged.
        ((isOwner && event.host === 'guild' && event.status !== 'settled' && event.status !== 'cancelled')
            || (!embedded && isAdmin && event.status !== 'settled' && event.status !== 'cancelled'))
            && React.createElement(Fold, {
                icon: "gear", title: "More actions", open: moreOpen, onToggle: () => setMoreOpen((v) => !v), minHeight: 52, bodyGap: 4, style: { marginTop: 12 },
                summary: [(isOwner && event.host === 'guild') && 'Cancel event', (!embedded && isAdmin) && 'Force-cancel (dispute)'].filter(Boolean).join(' \u00B7 '),
            },
        isOwner && event.host === 'guild' && event.status !== 'settled' && event.status !== 'cancelled' && React.createElement("div", { style: { marginTop: 12 } },
            !showCancelConfirm
                ? React.createElement("button", { onClick: () => setShowCancelConfirm(true), style: { ...cardBtn(false), color: C.danger, borderColor: dangerA(0.4) } }, 'Cancel event')
                : React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginBottom: 6 } },
                        'Cancel this event? This only works while no one has paid to enter yet \u2014 any escrowed prize is released back to the guild treasury.'),
                    React.createElement("div", { style: S.row8 },
                        React.createElement("button", { disabled: cancelling, onClick: handleCancelEvent, style: { ...cardBtn(true), opacity: cancelling ? 0.5 : 1 } }, cancelling ? '\u2026' : 'Yes, cancel it'),
                        React.createElement("button", { onClick: () => setShowCancelConfirm(false), style: cardBtn(false) }, 'Never mind')))),
        !embedded && isAdmin && event.status !== 'settled' && event.status !== 'cancelled' && React.createElement("div", { style: S.divider },
            !showAdminCancel
                ? React.createElement("button", { onClick: () => setShowAdminCancel(true), style: { ...cardBtn(false), color: C.danger, borderColor: dangerA(0.4) } }, 'Force-cancel (dispute)')
                : React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginBottom: 6 } },
                        'This does not refund any entrant automatically \u2014 process real refunds in Paystack by hand afterward.'),
                    React.createElement("textarea", { value: adminCancelReason, onChange: (e) => setAdminCancelReason(e.target.value), rows: 2, placeholder: "Reason for the dispute cancellation", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } }),
                    adminCancelError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11], marginTop: 6 } }, adminCancelError),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 8 } },
                        React.createElement("button", { disabled: adminCancelBusy, onClick: handleAdminCancel, style: { ...cardBtn(true), opacity: adminCancelBusy ? 0.5 : 1 } }, adminCancelBusy ? '\u2026' : 'Force-cancel this event'),
                        React.createElement("button", { onClick: () => setShowAdminCancel(false), style: cardBtn(false) }, 'Never mind'))))),

        // ---------- Owner lifecycle controls ----------
        isOwner && (approvalStatus === 'draft' || approvalStatus === 'rejected') && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { onClick: () => onEdit(event), style: cardBtn(false) }, approvalStatus === 'rejected' ? 'Edit & resubmit' : 'Edit'),
            React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => submitGuildEventForApproval(gId, eId)), style: { ...cardBtn(true), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Submit for review')),

        isOwner && approvalStatus === 'pending_approval' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, fontStyle: 'italic', marginTop: 10 } }, 'Waiting on Inkroot to review this submission.'),

        isOwner && approvalStatus === 'approved' && event.host === 'guild' && React.createElement(HostingFeePanel, { event, onPublished: () => runLifecycle((gId, eId) => publishGuildEvent(gId, eId)) }),

        isOwner && approvalStatus === 'published' && React.createElement("div", { style: { marginTop: 12 } },
            React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => activateGuildEvent(gId, eId)), style: { ...cardBtn(true), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Activate \u2014 open for entries')),

        isOwner && event.host === 'guild' && approvalStatus === 'active' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            event.status === 'open' && React.createElement("button", { disabled: closing, onClick: handleClose, style: { ...cardBtn(false), opacity: closing ? 0.5 : 1 } }, closing ? '\u2026' : (event.event_type === 'tournament' ? 'Close entries & start the bracket' : 'Close entries')),
            // Migration 176: a tournament finishes by itself when its final is decided (the server refuses a manual completion).
            event.event_type !== 'tournament' && React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => completeGuildEvent(gId, eId)), style: { ...cardBtn(false), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Mark completed')),

        // Migration 120: settle_guild_event() no longer accepts a direct authenticated call for
        // host='guild' events (see that migration's header) — settlement now only happens
        // through submit_guild_event_results()/approve_guild_event_results() below, which keeps
        // the organizer-submits/a-different-authority-approves separation the app already relies
        // on. This direct "Declare winners…" control would just fail server-side now, so it's
        // restricted to host='inkroot' (unchanged from before this migration).
        isOwner && event.host === 'inkroot' && !isOfficialGame && ['active', 'completed'].includes(approvalStatus) && event.status !== 'settled' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { onClick: () => setShowSettle((v) => !v), style: cardBtn(false) }, showSettle ? 'Cancel' : 'Declare winners \u2026')),

        // Also hidden once the event reads 'settled': if the settle went through but its response was
        // lost, the refetch in handleSettle's catch flips the event to settled while showSettle is
        // still true — without this the form (and its Settle button) would stay on screen.
        isOwner && showSettle && !isOfficialGame && event.status !== 'settled' && React.createElement("div", { style: S.divider },
            winnerRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                React.createElement("select", {
                    value: row.memberId, style: { ...evInputStyle, flex: 2 },
                    onChange: (e) => setWinnerRows((rows) => rows.map((r, ri) => ri === i ? { ...r, memberId: e.target.value } : r)),
                },
                    React.createElement("option", { value: "" }, 'Choose a member\u2026'),
                    members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id))),
                React.createElement("input", {
                    type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 70 },
                    onChange: (e) => setWinnerRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                }))),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                React.createElement("button", { onClick: () => setWinnerRows((rows) => [...rows, { memberId: '', sharePct: '' }]), style: { ...cardBtn(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add winner'),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: shareTargetMet ? C.neutral : C.danger } },
                    requiredSharePct != null ? `${totalSharePct}% allocated \u2014 must total exactly ${requiredSharePct}% (the locked prize pool)` : `${totalSharePct}% allocated`)),
            React.createElement("button", { disabled: settling || !shareTargetMet, onClick: handleSettle, style: { ...cardBtn(true), marginTop: 10, opacity: (settling || !shareTargetMet) ? 0.5 : 1 } }, settling ? 'Settling\u2026' : 'Settle & pay winners')),

        // ---------- Organizer results submission ----------
        // A second, delegated path onto the same settlement: the event's own organizer proposes
        // placements once it's completed, instead of (or alongside) the guild owner declaring
        // winners directly above. Nothing is paid out here \u2014 see the approval panel below
        // for the step that actually moves money.
        // Computed events (a locked judging config exists): no submit/approve step. A giveaway is drawn by its own
        // panel; a finished tournament is computed here too (migration 176 ranks it from its bracket).
        !embedded && event.host === 'guild' && !isGuildGiveaway && approvalStatus === 'completed' && event.status !== 'settled' && objConfig
            && React.createElement(ComputedResultsControls, { event, config: objConfig, canCompute: !!(isOwner || isOrganizer || isAdmin || canApprove), isAdmin: !!isAdmin, results, onChanged }),

        // Legacy only: an event from before migration 167 has no config row, so its organizer still declares results
        // and a different guild authority approves them (migration 49). Nothing else reaches this block any more.
        objConfig === null && !isGuildGiveaway && isOrganizer && approvalStatus === 'completed' && event.status !== 'settled' && (!results || results.status !== 'approved')
            && React.createElement("div", { style: S.divider },
                results && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: RESULTS_STATUS_COLORS[results.status], marginBottom: 8 } },
                    `Results ${RESULTS_STATUS_LABELS[results.status] || results.status}`),
                results && results.status === 'rejected' && results.rejection_reason && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginBottom: 8, fontStyle: 'italic' } }, `Reason: ${results.rejection_reason}`),
                !showSubmitResults && React.createElement("button", { onClick: openSubmitResults, style: cardBtn(false) },
                    !results ? 'Submit results \u2026' : results.status === 'rejected' ? 'Revise & resubmit \u2026' : 'Edit submission \u2026'),
                showSubmitResults && React.createElement("div", { style: { marginTop: 10 } },
                    React.createElement("div", { style: S.softHint },
                        'This only proposes a payout \u2014 a guild leader, treasurer, or officer (other than you) must approve it before winners are actually paid.'),
                    resultRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                        React.createElement("input", {
                            type: "number", min: "1", placeholder: "Place", value: row.place, style: { ...evInputStyle, width: 70 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                        }),
                        React.createElement("select", {
                            value: row.memberId, style: { ...evInputStyle, flex: 2 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, memberId: e.target.value } : r)),
                        },
                            React.createElement("option", { value: "" }, 'Choose a member\u2026'),
                            members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id))),
                        React.createElement("input", {
                            type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 70 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                        }))),
                    React.createElement("button", { onClick: () => setResultRows((rows) => [...rows, { place: String(rows.length + 1), memberId: '', sharePct: '' }]), style: { ...cardBtn(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add place'),
                    resultsError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11], marginTop: 8 } }, resultsError),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 10 } },
                        React.createElement("button", { disabled: resultsBusy, onClick: handleSubmitResults, style: { ...cardBtn(true), opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Submit for approval'),
                        React.createElement("button", { onClick: () => setShowSubmitResults(false), style: cardBtn(false) }, 'Cancel')))),

        // ---------- Reviewer approval ----------
        // Only rendered for an authorized guild role, and never lets that same person approve
        // their own submission \u2014 approve_guild_event_results()/reject_guild_event_results()
        // refuse that server-side regardless, this just avoids showing buttons that would fail.
        canApprove && results && results.status === 'pending_approval' && React.createElement("div", { style: S.divider },
            React.createElement("div", { style: S.fieldLabel }, 'Proposed results \u2014 awaiting approval'),
            results.placements.map((p, i) => React.createElement("div", { key: i, style: { fontSize: TYPE_SCALE[11.5], color: C.textDim, marginBottom: 3 } },
                `#${p.place} \u2014 ${(members.find((m) => m.user_id === p.contributorId) || {}).name || p.contributorId} \u2014 ${p.sharePct}%`)),
            resultsError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11], marginTop: 8 } }, resultsError),
            myUserId != null && myUserId === results.submitted_by
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textMuted, fontStyle: 'italic', marginTop: 8 } }, "You submitted these results \u2014 another guild leader, treasurer, or officer needs to approve them.")
                : React.createElement("div", { style: { marginTop: 8 } },
                    React.createElement("div", { style: S.row8 },
                        React.createElement("button", { disabled: resultsBusy, onClick: handleApproveResults, style: { ...cardBtn(true), opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Approve & pay winners'),
                        React.createElement("button", { disabled: resultsBusy, onClick: () => setShowReject((v) => !v), style: cardBtn(false) }, showReject ? 'Cancel' : 'Reject')),
                    showReject && React.createElement("div", { style: { marginTop: 8 } },
                        React.createElement("textarea", { value: rejectReason, onChange: (e) => setRejectReason(e.target.value), rows: 2, placeholder: "Why are these results being sent back?", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } }),
                        React.createElement("button", { disabled: resultsBusy, onClick: handleRejectResults, style: { ...cardBtn(false), marginTop: 6, opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Send back for revision')))));
}
