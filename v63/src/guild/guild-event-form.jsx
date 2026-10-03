import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useRef, useState } from 'react';
import { computeEntryFinancialBreakdown, fetchGuildEventFinancialAgreement, fetchGuildEventObjectiveConfig, fetchPlatformFeePct, uploadGuildEventCover } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { readLocalImageFile } from '../shared-ui/image-utils.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { WordRangeFields, validateWordRange } from './guild-event-word-range-fields.jsx';
import { GiveawayDrawFields } from './guild-event-giveaway-panel.jsx';
import { QuizHostSection } from './guild-event-quiz-panel.jsx';
import { TournamentHostSection } from './guild-event-tournament-panel.jsx';
import { withIcon } from '../shell/ink-icon.jsx';
import { EVENT_TYPE_LABELS, OBJECTIVE_METRIC_LABELS, evBtnStyle, evInputStyle, evLabelStyle, formatEventDate, toDateInputValue } from './guild-event-ui.jsx';
import { FinancialFlowDiagram } from './guild-event-finance.jsx';

// The full Guild Event submission form — every field from the migration header: title,
// description, rules, event type, entry fee, participant limit, prize structure, guild share,
// start/end date, organizer, cover image. Shared between "+ Host a guild event" (create) and
// "Edit" on a draft/rejected event (edit) — `initial` is either null (create) or an existing
// event's fields (edit).
// The four steps of the create/edit form, in order (see the step-by-step note inside GuildEventForm).
const EVENT_FORM_STEPS = ['Basics', 'Schedule & entry', 'Prizes & money', 'Review'];
// Short names for the stepper under the progress bars only (the full names stay as the step heading).
const EVENT_FORM_STEP_SHORT = ['Basics', 'Entry', 'Prizes', 'Review'];

// Look only: a thin fill bar for the "must total 100%" lines. It draws the same number the text beside it prints.
function AllocMeter({ pct }) {
    const n = Number(pct) || 0;
    const exact = Math.round(n * 100) === 10000;
    return React.createElement("div", { "aria-hidden": "true", style: { height: 4, borderRadius: RADIUS_SCALE[100], background: C.border, overflow: 'hidden', margin: '6px 0 4px' } },
        React.createElement("div", { style: { height: '100%', width: `${Math.max(0, Math.min(100, n))}%`, background: exact ? C.success : (n > 100 ? C.danger : C.gold), transition: 'width var(--ink-dur) var(--ink-ease), background var(--ink-dur) var(--ink-ease)' } }));
}

export function GuildEventForm({ members, guildId, initial, onCancel, onSave }) {
    const [fields, setFields] = useState(() => ({
        title: initial?.title || '',
        description: initial?.description || '',
        rules: initial?.rules || '',
        eventType: initial?.event_type || '',
        entryFeeNaira: initial?.entryFeeNaira != null ? String(initial.entryFeeNaira) : '',
        participantLimit: initial?.participant_limit != null ? String(initial.participant_limit) : '',
        guildSharePct: initial?.guild_share_bps != null ? String(initial.guild_share_bps / 100) : '',
        startDate: toDateInputValue(initial?.start_date),
        endDate: toDateInputValue(initial?.end_date),
        organizerId: initial?.organizer_id || '',
        coverImageUrl: initial?.cover_image_url || '',
        guaranteedPrizeNaira: initial?.guaranteedPrizeNaira != null ? String(initial.guaranteedPrizeNaira) : '',
        // Writing-contest word range — see guild-event-word-range-fields.jsx for why these are
        // inert until the backend supports them (undefined on `initial` today, so always '').
        minWordCount: initial?.minWordCount != null ? String(initial.minWordCount) : '',
        maxWordCount: initial?.maxWordCount != null ? String(initial.maxWordCount) : '',
        // Giveaway draw method (migration 171) — required on a giveaway, locked once the event leaves draft.
        drawMethod: initial?.drawMethod || '',
    }));
    const [prizeRows, setPrizeRows] = useState(
        (initial?.prize_structure && initial.prize_structure.length > 0)
            ? initial.prize_structure.map((p) => ({ place: p.place != null ? String(p.place) : '', sharePct: p.share_pct != null ? String(p.share_pct) : '' }))
            : [{ place: '1', sharePct: '' }]
    );
    // The locked, enforced money split — see 48_migration_guild_event_financial_agreement.sql.
    // Distinct from prizeRows above (which only guides how the prize pool gets divided among
    // placements once winners are known — still informational, unenforced): this is what
    // actually gates how much of the pool goes to winners vs. the guild, checked server-side at
    // settlement. Defaults to "100% to the prize pool" for a brand-new event so a first-time
    // organizer isn't forced to think about a guild cut before they can save anything.
    const [prizePoolPct, setPrizePoolPct] = useState('100');
    const [guildSharePct, setGuildSharePct] = useState('0');
    const [otherAllocRows, setOtherAllocRows] = useState([]);
    // Judging configuration — see 121_migration_guild_event_fair_judging.sql. Every host='guild'
    // event needs one of these on file before it can activate; placements get computed from this,
    // never declared by the organizer. Distinct from prizeRows above (which stays purely
    // informational) — placementSplitRows is what compute_guild_event_placements() actually pays
    // out against. Defaults to "pure judge panel, winner takes the whole pool" so a first-time
    // organizer isn't forced to understand the objective-metric math before saving a draft.
    const [objectiveMetric, setObjectiveMetric] = useState('none');
    const [objectiveWeightPct, setObjectiveWeightPct] = useState('0');
    const [placementSplitRows, setPlacementSplitRows] = useState([{ place: '1', sharePct: '100' }]);
    const [objectiveLocked, setObjectiveLocked] = useState(false);
    const [coverUploading, setCoverUploading] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    // Inkroot's real, current per-entry cut \u2014 read fresh the same way handleSaveForm below
    // (and proposeGuildEventFinancialAgreement's own doc comment) already insists on, purely so
    // the live preview never shows a % that could drift from what actually gets proposed on save.
    const [platformFeeBps, setPlatformFeeBps] = useState(null);
    useEffect(() => { fetchPlatformFeePct().then((pct) => setPlatformFeeBps(pct * 100)).catch(() => {}); }, []);

    // Loads the existing agreement when editing a draft/rejected event that already has one —
    // a brand-new event (initial === null) has nothing to load, and keeps the 100%/0% default.
    useEffect(() => {
        if (!initial) return;
        let cancelled = false;
        fetchGuildEventFinancialAgreement(initial.id).then((a) => {
            if (cancelled || !a) return;
            setPrizePoolPct(String(a.prize_pool_bps / 100));
            setGuildSharePct(String(a.guild_share_bps / 100));
            setOtherAllocRows((a.other_allocations || []).map((x) => ({ label: x.label, sharePct: String(x.bps / 100) })));
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [initial]);

    // Loads the existing judging config the same way — an event with none yet (brand new, or a
    // draft never taken past the old form) keeps the pure-judge-panel default above.
    useEffect(() => {
        if (!initial) return;
        let cancelled = false;
        fetchGuildEventObjectiveConfig(initial.id).then((c) => {
            if (cancelled || !c) return;
            setObjectiveMetric(c.metric);
            setObjectiveWeightPct(String(c.weight_bps / 100));
            setObjectiveLocked(c.locked);
            if (c.placement_split_bps && c.placement_split_bps.length > 0) {
                setPlacementSplitRows(c.placement_split_bps.map((p) => ({ place: String(p.place), sharePct: String(p.share_bps / 100) })));
            }
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [initial]);

    // metric = 'none' requires weight = 0 — propose_guild_event_objective_config() refuses the
    // combination server-side too, this just stops the form from ever offering it.
    const handleMetricChange = (e) => {
        const v = e.target.value;
        setObjectiveMetric(v);
        if (v === 'none') setObjectiveWeightPct('0');
    };

    // World-Building ('workshop' — see EVENT_TYPE_LABELS' own comment above) is judged purely by
    // the blind panel per the redesign spec: "the word-count / on-time objective metrics don't
    // apply to this type." Force+lock the metric to 'none' the instant this type is chosen, same
    // as handleMetricChange already does when 'none' is picked directly, so a host can never save
    // a World-Building event with a metric that will never mean anything for it.
    const handleEventTypeChange = (e) => {
        const v = e.target.value;
        setFields((f) => ({ ...f, eventType: v }));
        if (v === 'workshop') { setObjectiveMetric('none'); setObjectiveWeightPct('0'); }
    };

    const otherAllocTotalPct = otherAllocRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);
    const financialTotalPct = (Number(prizePoolPct) || 0) + (Number(guildSharePct) || 0) + otherAllocTotalPct;
    const placementSplitTotalPct = placementSplitRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);

    // Same shape computeEntryFinancialBreakdown expects from a real, saved
    // guild_event_financial_agreements row \u2014 built from this form's own in-progress values
    // purely for display; nothing here is sent anywhere (the actual save is still
    // proposeGuildEventFinancialAgreement, unchanged, in handleSaveForm below).
    const previewAgreement = platformFeeBps != null ? {
        platform_fee_bps: platformFeeBps,
        prize_pool_bps: Math.round((Number(prizePoolPct) || 0) * 100),
        guild_share_bps: Math.round((Number(guildSharePct) || 0) * 100),
        other_allocations: otherAllocRows.filter((r) => r.label && r.sharePct)
            .map((r) => ({ label: r.label, bps: Math.round((Number(r.sharePct) || 0) * 100) })),
    } : null;
    const previewEntryFeeKobo = fields.entryFeeNaira && Number(fields.entryFeeNaira) > 0 ? Math.round(Number(fields.entryFeeNaira) * 100) : null;
    const previewBreakdown = computeEntryFinancialBreakdown(previewEntryFeeKobo, previewAgreement);

    const patch = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));
    const judgeFree = ['giveaway', 'reading_challenge', 'tournament'].includes(fields.eventType);

    const handleCoverFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        setError(null);
        setCoverUploading(true);
        try {
            const dataUrl = await readLocalImageFile(file, 1000, 0.85);
            const uploadedUrl = await uploadGuildEventCover(dataUrl);
            // guild_events is a publicly readable table (closes #26) — unlike avatar/crest/cover
            // uploads elsewhere, there's no local-only draft to fall back to, so a failed upload
            // must not leave a base64 data URL sitting in coverImageUrl waiting to be saved.
            if (!uploadedUrl) {
                setError("Couldn't upload the cover — try again.");
                return;
            }
            setFields((f) => ({ ...f, coverImageUrl: uploadedUrl }));
        } catch (err) {
            setError(err.message || 'Could not use that image.');
        } finally {
            setCoverUploading(false);
        }
    };

    const handleSubmit = async () => {
        if (!fields.title.trim()) { setError('Give the event a title.'); return; }
        if (!fields.eventType) { setError('Choose an event type.'); return; }
        if (fields.eventType !== 'giveaway' && (!fields.entryFeeNaira || Number(fields.entryFeeNaira) <= 0)) { setError('Set a positive entry fee.'); return; }
        if (!prizePoolPct || Number(prizePoolPct) <= 0) { setError('The prize pool needs a positive share \u2014 participants are paying to compete for something.'); return; }
        if (otherAllocRows.some((r) => r.label && !r.sharePct)) { setError('Give every other allocation a share, or remove the row.'); return; }
        if (Math.round(financialTotalPct * 100) !== 10000) {
            setError(`Prize pool + guild share + other allocations must add up to exactly 100% \u2014 currently ${financialTotalPct}%.`);
            return;
        }
        if (fields.guaranteedPrizeNaira && Number(fields.guaranteedPrizeNaira) <= 0) {
            setError('Guaranteed prize must be a positive amount, or left blank.');
            return;
        }
        if (!fields.startDate || !fields.endDate) {
            setError('Choose a start and end date for the event.');
            return;
        }
        if (new Date(fields.endDate) <= new Date(fields.startDate)) {
            setError('End date must be after the start date.');
            return;
        }
        if (objectiveWeightPct === '' || Number(objectiveWeightPct) < 0 || Number(objectiveWeightPct) > 100) {
            setError('Objective weight must be between 0% and 100%.');
            return;
        }
        if (objectiveMetric === 'none' && Number(objectiveWeightPct) !== 0) {
            setError('An objective weight requires an objective metric.');
            return;
        }
        if (placementSplitRows.some((r) => r.place && !r.sharePct)) {
            setError('Give every judging placement a share, or remove the row.');
            return;
        }
        // For now a quiz or tournament pays 1st-3rd only, and a giveaway pays one winner (its split is fixed at 100%).
        if (['reading_challenge', 'tournament'].includes(fields.eventType)
            && placementSplitRows.some((r) => r.place && !['1', '2', '3'].includes(String(Number(r.place))))) {
            setError('This kind of event pays 1st, 2nd and 3rd place only \u2014 remove any other place from the prize split.');
            return;
        }
        if (Math.round(placementSplitTotalPct * 100) !== 10000) {
            setError(`Judging placement split must add up to exactly 100% \u2014 currently ${placementSplitTotalPct}%.`);
            return;
        }
        if (fields.eventType === 'writing_contest') {
            const rangeError = validateWordRange(fields.minWordCount, fields.maxWordCount);
            if (rangeError) { setError(rangeError); return; }
        }
        setBusy(true);
        setError(null);
        try {
            const prizeStructure = prizeRows
                .filter((r) => r.place && r.sharePct)
                .map((r) => ({ place: Number(r.place), share_pct: Number(r.sharePct) }));
            const otherAllocations = otherAllocRows.filter((r) => r.label && r.sharePct);
            const placementSplit = placementSplitRows.filter((r) => r.place && r.sharePct);
            await onSave({
                ...fields, prizeStructure,
                financial: { prizePoolPct, guildSharePct, otherAllocations },
                // Judge-free types save a neutral judging row (the server replaces it at activation); a giveaway pays one winner.
                judging: judgeFree
                    ? { metric: 'none', weightPct: '0', placementSplit: fields.eventType === 'giveaway' ? [{ place: '1', sharePct: '100' }] : placementSplit }
                    : { metric: objectiveMetric, weightPct: objectiveWeightPct, placementSplit },
            });
        } catch (e) {
            setError(e.message || 'Could not save this event.');
        } finally {
            setBusy(false);
        }
    };

    // ---- Step-by-step flow (1 of 4) -------------------------------------------------------------------------
    // The form used to be one long scroll with Save at the very bottom. It is now four steps; every field, state
    // variable and handleSubmit above are unchanged. All four steps stay mounted and the inactive ones are only
    // hidden, so a half-typed field or a host section (tournament, quiz) that holds its own draft is never lost
    // when you go Back. stepError() re-states the checks handleSubmit makes, grouped by step, only so Next can stop
    // on the step that owns the problem; handleSubmit is still the final authority and runs on Save exactly as before.
    const [step, setStep] = useState(1);
    const [maxStep, setMaxStep] = useState(initial ? EVENT_FORM_STEPS.length : 1); // editing a draft: every step is reachable
    const formTopRef = useRef(null);
    const stepMounted = useRef(false);
    useEffect(() => {
        if (!stepMounted.current) { stepMounted.current = true; return; }
        const el = formTopRef.current;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }, [step]);

    const stepError = (n) => {
        if (n === 1) {
            if (!fields.title.trim()) return 'Give the event a title.';
            if (!fields.eventType) return 'Choose an event type.';
        }
        if (n === 2) {
            if (fields.eventType !== 'giveaway' && (!fields.entryFeeNaira || Number(fields.entryFeeNaira) <= 0)) return 'Set a positive entry fee.';
            if (!fields.startDate || !fields.endDate) return 'Choose a start and end date for the event.';
            if (new Date(fields.endDate) <= new Date(fields.startDate)) return 'End date must be after the start date.';
            if (fields.eventType === 'writing_contest') { const r = validateWordRange(fields.minWordCount, fields.maxWordCount); if (r) return r; }
        }
        if (n === 3) {
            if (!prizePoolPct || Number(prizePoolPct) <= 0) return 'The prize pool needs a positive share \u2014 participants are paying to compete for something.';
            if (otherAllocRows.some((r) => r.label && !r.sharePct)) return 'Give every other allocation a share, or remove the row.';
            if (Math.round(financialTotalPct * 100) !== 10000) return `Prize pool + guild share + other allocations must add up to exactly 100% \u2014 currently ${financialTotalPct}%.`;
            if (fields.guaranteedPrizeNaira && Number(fields.guaranteedPrizeNaira) <= 0) return 'Guaranteed prize must be a positive amount, or left blank.';
            if (objectiveWeightPct === '' || Number(objectiveWeightPct) < 0 || Number(objectiveWeightPct) > 100) return 'Objective weight must be between 0% and 100%.';
            if (objectiveMetric === 'none' && Number(objectiveWeightPct) !== 0) return 'An objective weight requires an objective metric.';
            if (placementSplitRows.some((r) => r.place && !r.sharePct)) return 'Give every judging placement a share, or remove the row.';
            if (['reading_challenge', 'tournament'].includes(fields.eventType)
                && placementSplitRows.some((r) => r.place && !['1', '2', '3'].includes(String(Number(r.place))))) return 'This kind of event pays 1st, 2nd and 3rd place only \u2014 remove any other place from the prize split.';
            if (Math.round(placementSplitTotalPct * 100) !== 10000) return `Judging placement split must add up to exactly 100% \u2014 currently ${placementSplitTotalPct}%.`;
        }
        return null;
    };
    const goNext = () => {
        const msg = stepError(step);
        if (msg) { setError(msg); return; }
        setError(null);
        setStep(step + 1);
        setMaxStep((m) => Math.max(m, step + 1));
    };
    const goBack = () => { setError(null); setStep(Math.max(1, step - 1)); };
    const goTo = (n) => { setError(null); setStep(n); };
    // Save from the Review step: if an earlier step is incomplete, go to it and say what is missing instead of
    // showing an error about a field that is not on screen. Otherwise hand over to handleSubmit unchanged.
    const handleSave = () => {
        for (let n = 1; n <= 3; n++) {
            const msg = stepError(n);
            if (msg) { setStep(n); setError(msg); return; }
        }
        handleSubmit();
    };
    const organizerName = (members.find((m) => m.user_id === fields.organizerId) || {}).name;
    const reviewRows = [
        { step: 1, label: 'Title', value: fields.title.trim() || '\u2014' },
        { step: 1, label: 'Type', value: EVENT_TYPE_LABELS[fields.eventType] || fields.eventType || '\u2014' },
        { step: 2, label: 'Dates', value: (formatEventDate(fields.startDate) && formatEventDate(fields.endDate)) ? `${formatEventDate(fields.startDate)} \u2192 ${formatEventDate(fields.endDate)}` : '\u2014' },
        { step: 2, label: 'Organizer', value: organizerName || 'None chosen' },
        { step: 2, label: 'Entry', value: fields.eventType === 'giveaway' ? 'Free' : (fields.entryFeeNaira ? formatNaira(Number(fields.entryFeeNaira)) : '\u2014') },
        { step: 2, label: 'Participant limit', value: fields.participantLimit || 'Unlimited' },
        { step: 3, label: 'Guaranteed prize', value: fields.guaranteedPrizeNaira ? formatNaira(Number(fields.guaranteedPrizeNaira)) : 'None' },
        { step: 3, label: 'Prize pool / guild', value: `${prizePoolPct || 0}% / ${guildSharePct || 0}%${otherAllocRows.filter((r) => r.label && r.sharePct).length ? ` + ${otherAllocRows.filter((r) => r.label && r.sharePct).length} other` : ''}` },
        { step: 3, label: fields.eventType === 'giveaway' ? 'Winner' : (judgeFree ? 'Prize split' : 'Judging'),
            value: fields.eventType === 'giveaway' ? 'One winner, drawn' : (judgeFree ? `${placementSplitRows.filter((r) => r.place && r.sharePct).length} place(s)` : `${OBJECTIVE_METRIC_LABELS[objectiveMetric] || objectiveMetric}${Number(objectiveWeightPct) > 0 ? ` (${objectiveWeightPct}%)` : ''}`) },
        { step: 1, label: 'Cover', value: fields.coverImageUrl ? 'Added' : 'None' },
    ];

    return React.createElement("div", { ref: formTopRef, style: { position: 'relative', scrollMarginTop: 12, display: 'grid', gap: SPACE_SCALE[10], background: `linear-gradient(165deg,${C.formTop},${C.posterBottom})`, border: '1px solid rgba(184,115,92,0.24)', borderRadius: RADIUS_SCALE[13], padding: '18px 14px 14px', marginBottom: 10 } },
        React.createElement("div", { style: { position: 'absolute', left: 14, right: 14, top: 0, height: 1, background: 'linear-gradient(90deg,transparent,rgba(184,115,92,0.45),transparent)' } }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9], letterSpacing: '0.14em', textTransform: 'uppercase', color: C.copper, marginBottom: 2 } }, withIcon('scales', "Event application", 11)),
        React.createElement("div", { "aria-live": "polite", style: { marginBottom: 2 } },
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 8 } },
                EVENT_FORM_STEPS.map((s, i) => React.createElement("button", {
                    key: s, type: "button", disabled: i + 1 > maxStep, onClick: () => goTo(i + 1), "aria-label": `Step ${i + 1}: ${s}`,
                    "aria-current": step === i + 1 ? 'step' : undefined,
                    style: { flex: 1, minHeight: 44, padding: '0 0 4px', border: 'none', background: 'none', cursor: i + 1 > maxStep ? 'default' : 'pointer', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: SPACE_SCALE[4], fontFamily: 'inherit' },
                },
                    React.createElement("span", { style: { display: 'block', height: 6, borderRadius: 3,
                        background: i + 1 <= step ? C.copper : (i + 1 <= maxStep ? 'rgba(184,115,92,0.4)' : C.statBorder), transition: 'background var(--ink-dur) var(--ink-ease)' } }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], textAlign: 'left', color: step === i + 1 ? C.text : C.textMuted, fontWeight: step === i + 1 ? 600 : 400 } }, EVENT_FORM_STEP_SHORT[i])))),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: SPACE_SCALE[8] } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: C.text } }, EVENT_FORM_STEPS[step - 1]),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft } }, `Step ${step} of ${EVENT_FORM_STEPS.length}`))),
        React.createElement("div", { key: "step1", style: { display: step === 1 ? "grid" : "none", gap: SPACE_SCALE[10] } },
        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Event title'),
            React.createElement("input", { value: fields.title, onChange: patch('title'), placeholder: "e.g. Autumn Flash Fiction Sprint", style: evInputStyle })),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Description'),
            React.createElement("textarea", { value: fields.description, onChange: patch('description'), rows: 3, placeholder: "What's this event about?", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } })),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Rules'),
            React.createElement("textarea", { value: fields.rules, onChange: patch('rules'), rows: 3, placeholder: "Eligibility, submission format, judging\u2026", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } })),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Event type'),
                React.createElement("select", { value: fields.eventType, onChange: handleEventTypeChange, style: evInputStyle },
                    React.createElement("option", { value: "" }, 'Choose an event type'),
                    // 'Other' stays visible only on an event that already is one; new events pick a real type.
                    Object.entries(EVENT_TYPE_LABELS).filter(([v]) => v !== 'other' || fields.eventType === 'other').map(([v, label]) => React.createElement("option", { key: v, value: v }, label)))),
        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Cover / banner'),
            fields.coverImageUrl && React.createElement("img", { src: fields.coverImageUrl, alt: "", style: { width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], marginBottom: 6 } }),
            React.createElement("div", { style: { padding: '12px 12px', border: `1px dashed ${C.borderStrong}`, borderRadius: RADIUS_SCALE[12], background: C.panel } },
                React.createElement("input", { type: "file", accept: "image/*", onChange: handleCoverFile, disabled: coverUploading, style: { fontSize: TYPE_SCALE[12], color: C.textSoft, maxWidth: '100%' } })),
            coverUploading && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 4 } }, 'Uploading\u2026'))),
        React.createElement("div", { key: "step2", style: { display: step === 2 ? "grid" : "none", gap: SPACE_SCALE[10] } },
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Organizer'),
                React.createElement("select", { value: fields.organizerId, onChange: patch('organizerId'), style: evInputStyle },
                    React.createElement("option", { value: "" }, 'None chosen'),
                    members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id)))),
        fields.eventType === 'writing_contest' && React.createElement(WordRangeFields, {
            minWordCount: fields.minWordCount, maxWordCount: fields.maxWordCount, locked: objectiveLocked,
            onChange: (key, value) => setFields((f) => ({ ...f, [key]: value })),
        }),

        fields.eventType === 'tournament' && React.createElement(TournamentHostSection, { guildId: guildId || (initial && initial.guild_id), members, event: initial }),

        fields.eventType === 'reading_challenge' && React.createElement(QuizHostSection, { guildId: guildId || (initial && initial.guild_id), members, event: initial }),

        fields.eventType === 'giveaway' && React.createElement(GiveawayDrawFields, {
            drawMethod: fields.drawMethod, locked: objectiveLocked,
            onChange: (key, value) => setFields((f) => ({ ...f, [key]: value })),
        }),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8] } },
            fields.eventType === 'giveaway'
                ? React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, 'Entry'),
                    React.createElement("div", { style: { ...evInputStyle, color: C.success } }, 'Free \u2014 tap to enter'))
                : React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, 'Entry fee (\u20a6)'),
                    React.createElement("input", { type: "number", min: "1", value: fields.entryFeeNaira, onChange: patch('entryFeeNaira'), style: evInputStyle })),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Participant limit'),
                React.createElement("input", { type: "number", min: "1", value: fields.participantLimit, onChange: patch('participantLimit'), placeholder: fields.eventType === 'tournament' ? 'Up to 2^rounds' : "Unlimited", style: evInputStyle }),
                // Migration 177: a tournament's limit is capped at 2^rounds by the server (blank = the cap); you can only lower it.
                fields.eventType === 'tournament' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 4 } },
                    'Leave blank for the most your bracket can hold (2 to the power of its rounds). You can only go lower.'))),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Start date *'),
                React.createElement("input", { type: "date", required: true, value: fields.startDate, onChange: patch('startDate'), style: evInputStyle })),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'End date *'),
                React.createElement("input", { type: "date", required: true, value: fields.endDate, onChange: patch('endDate'), style: evInputStyle })))),
        React.createElement("div", { key: "step3", style: { display: step === 3 ? "grid" : "none", gap: SPACE_SCALE[10] } },
        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, "Guaranteed prize (\u20a6, optional \u2014 must be locked in escrow from the guild treasury before this event can be submitted for review)"),
            React.createElement("input", { type: "number", min: "1", value: fields.guaranteedPrizeNaira, onChange: patch('guaranteedPrizeNaira'), placeholder: "Leave blank for no guaranteed prize", style: evInputStyle })),
        React.createElement("div", { style: S.insetPanel },
            React.createElement("div", { style: { ...evLabelStyle, marginBottom: 8 } }, "Financial agreement \u2014 locked once this event opens for entries"),
            React.createElement("div", { style: S.softHint },
                "Every entrant sees this breakdown before they pay. Once the event is activated, it can never be changed \u2014 and settling the event will refuse any winner shares that don't add up to exactly the prize pool below."),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8], marginBottom: 8 } },
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Prize pool (%)"),
                    React.createElement("input", { type: "number", min: "0", max: "100", value: prizePoolPct, onChange: (e) => setPrizePoolPct(e.target.value), style: evInputStyle })),
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Guild's own share (%)"),
                    React.createElement("input", { type: "number", min: "0", max: "100", value: guildSharePct, onChange: (e) => setGuildSharePct(e.target.value), style: evInputStyle }))),
            React.createElement("div", { style: { marginBottom: 8 } },
                React.createElement("label", { style: evLabelStyle }, "Other agreed allocations \u2014 e.g. judges, charity, co-host"),
                otherAllocRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                    React.createElement("input", {
                        placeholder: "Label (e.g. Judges' honorarium)", value: row.label, style: { ...evInputStyle, flex: 2 },
                        onChange: (e) => setOtherAllocRows((rows) => rows.map((r, ri) => ri === i ? { ...r, label: e.target.value } : r)),
                    }),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 80 },
                        onChange: (e) => setOtherAllocRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                    }),
                    React.createElement("button", { onClick: () => setOtherAllocRows((rows) => rows.filter((_, ri) => ri !== i)), style: { ...evBtnStyle(false), padding: '4px 12px', minHeight: 44, minWidth: 44 } }, '\u2715'))),
                React.createElement("button", { onClick: () => setOtherAllocRows((rows) => [...rows, { label: '', sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[12], padding: '4px 12px', minHeight: 44 } }, '+ Add allocation')),
            React.createElement(AllocMeter, { pct: financialTotalPct }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: Math.round(financialTotalPct * 100) === 10000 ? C.success : C.danger } },
                `${financialTotalPct}% allocated \u2014 must total 100%`)),
        // Live preview of the same Entry Fee \u2192 Inkroot Fee \u2192 Prize Pool \u2192 Guild
        // Share \u2192 Other Allocations flow an entrant and the pre-publish review both see \u2014
        // computed from this form's own current values plus the real, current platform fee (never
        // a guessed or hardcoded %), so what the organizer previews here is what actually applies.
        React.createElement(FinancialFlowDiagram, { breakdown: previewBreakdown, locked: false }),
        // Judging configuration \u2014 see 121_migration_guild_event_fair_judging.sql. Every judged event
        // needs a locked row before it can open. Giveaway / quiz / tournament are judge-free (migration 169):
        // activation replaces whatever is saved with a locked judge-free config and keeps only the placement
        // split, so a giveaway shows nothing here and the others show just the split.
        fields.eventType === 'giveaway' && React.createElement("div", { style: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], padding: 10, fontSize: TYPE_SCALE[10.5], color: C.gold, fontStyle: 'italic' } },
            'A giveaway has one winner, who takes the whole prize. The winner is picked by the draw method you choose \u2014 there are no judges, and members of this guild can\u2019t enter or win.'),
        fields.eventType !== 'giveaway' && React.createElement("div", { style: S.insetPanel },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                React.createElement("div", { style: { ...evLabelStyle, marginBottom: 0 } }, (judgeFree ? "Prize split by place \u2014 locked once this event opens for entries" : "Configure judging \u2014 locked once this event opens for entries")),
                objectiveLocked && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], fontWeight: 600, color: C.success } }, 'Locked')),
            !judgeFree && React.createElement("div", { style: S.softHint },
                "Placements are computed, not declared \u2014 nobody on this guild's side hand-picks a winner. Whatever weight isn't covered by the metric below goes to a panel of Inkroot admins (never anyone from this guild), assigned automatically when the event opens, scoring each entry blind (\"Entry 1\", \"Entry 2\"\u2026 \u2014 never a name)."),
            judgeFree && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.gold, marginBottom: 8, fontStyle: 'italic' } },
                fields.eventType === 'tournament' ? 'Tournament winners come from the bracket, not from judges. Members of this guild can\u2019t enter or win.' : 'Quiz winners are ranked by score \u2014 fastest time breaks ties \u2014 and paid automatically when the quiz is computed. There are no judges, and members of this guild (and anyone who wrote a question) can\u2019t enter or win.'),
            fields.eventType === 'workshop' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.gold, marginBottom: 8, fontStyle: 'italic' } },
                "World-Building entries are judged purely by the panel below \u2014 there's no manuscript to score, so the objective metric is locked to \u2018None\u2019 for this type."),
            !judgeFree && React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8], marginBottom: 8 } },
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Objective metric"),
                    React.createElement("select", { value: objectiveMetric, disabled: objectiveLocked || fields.eventType === 'workshop', onChange: handleMetricChange, style: evInputStyle },
                        Object.entries(OBJECTIVE_METRIC_LABELS).map(([v, label]) => React.createElement("option", { key: v, value: v }, label)))),
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Objective weight (%)"),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", value: objectiveWeightPct,
                        disabled: objectiveLocked || objectiveMetric === 'none',
                        onChange: (e) => setObjectiveWeightPct(e.target.value), style: evInputStyle,
                    }))),
            !judgeFree && React.createElement("div", { style: S.softHint },
                Number(objectiveWeightPct) >= 100
                    ? 'Pure objective \u2014 no judge panel needed.'
                    : Number(objectiveWeightPct) <= 0
                        ? 'Pure judge panel \u2014 every entry is scored blind, 0\u2013100, by 3\u20135 assigned judges.'
                        : `${objectiveWeightPct}% from the metric above, ${100 - Number(objectiveWeightPct)}% from the judge panel's blind scores.`),
            React.createElement("div", { style: { marginBottom: 8 } },
                React.createElement("label", { style: evLabelStyle }, "Placement split \u2014 how the prize pool is divided once placements are computed (must total 100%)"),
                placementSplitRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                    React.createElement("input", {
                        type: "number", min: "1", placeholder: "Place", value: row.place, disabled: objectiveLocked, style: { ...evInputStyle, width: 90 },
                        onChange: (e) => setPlacementSplitRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                    }),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", placeholder: "Share %", value: row.sharePct, disabled: objectiveLocked, style: { ...evInputStyle, width: 100 },
                        onChange: (e) => setPlacementSplitRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                    }),
                    !objectiveLocked && React.createElement("button", { onClick: () => setPlacementSplitRows((rows) => rows.filter((_, ri) => ri !== i)), style: { ...evBtnStyle(false), padding: '4px 12px', minHeight: 44, minWidth: 44 } }, '\u2715'))),
                !objectiveLocked && !(judgeFree && placementSplitRows.length >= 3) && React.createElement("button", { onClick: () => setPlacementSplitRows((rows) => [...rows, { place: String(rows.length + 1), sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[12], padding: '4px 12px', minHeight: 44 } }, '+ Add place')),
            judgeFree && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.gold, marginBottom: 6, fontStyle: 'italic' } },
                'For now this kind of event pays 1st, 2nd and 3rd place only (up to 3 rows).'),
            React.createElement(AllocMeter, { pct: placementSplitTotalPct }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: Math.round(placementSplitTotalPct * 100) === 10000 ? C.success : C.danger } },
                `${placementSplitTotalPct}% allocated \u2014 must total 100%`)),
        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, "Prize structure \u2014 how the prize pool above is split by placement, e.g. 1st/2nd/3rd (a guide for declaring winners, not separately enforced)"),
            prizeRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                React.createElement("input", {
                    type: "number", min: "1", placeholder: "Place", value: row.place, style: { ...evInputStyle, width: 90 },
                    onChange: (e) => setPrizeRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                }),
                React.createElement("input", {
                    type: "number", min: "0", max: "100", placeholder: "Share %", value: row.sharePct, style: { ...evInputStyle, width: 100 },
                    onChange: (e) => setPrizeRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                }))),
            React.createElement("button", { onClick: () => setPrizeRows((rows) => [...rows, { place: String(rows.length + 1), sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[12], padding: '4px 12px', minHeight: 44 } }, '+ Add place'))),
        React.createElement("div", { key: "step4", style: { display: step === 4 ? "grid" : "none", gap: SPACE_SCALE[8] } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.textSoft, lineHeight: 1.6 } },
                initial ? "Check the details, then save your changes. Nothing is published yet \u2014 this stays a draft." : "Check the details, then create the draft. Nothing is published yet \u2014 you can still edit it before it goes for review."),
            React.createElement("div", { style: { ...S.insetPanel, padding: '0 12px' } },
                reviewRows.map((r, ri) => React.createElement("div", { key: r.label, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[12], minHeight: 44, borderBottom: ri === reviewRows.length - 1 ? 'none' : `1px solid ${C.statBorder}` } },
                    React.createElement("button", { type: "button", onClick: () => goTo(r.step), "aria-label": "Edit " + r.label, style: { background: 'none', border: 'none', padding: 0, minHeight: 44, cursor: 'pointer', textAlign: 'left', color: C.textSoft, fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit', flexShrink: 0 } }, `${r.label} \u203a`),
                    React.createElement("div", { style: { color: C.text, fontSize: TYPE_SCALE[13], textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' } }, r.value)))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textMuted } }, 'Tap a row to edit that step.'),
            React.createElement(AllocMeter, { pct: financialTotalPct }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: Math.round(financialTotalPct * 100) === 10000 ? C.success : C.danger } },
                `Money split: ${financialTotalPct}% allocated \u2014 must total 100%`)),
        error && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11] } }, error),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center', flexWrap: 'wrap' } },
            step > 1 && React.createElement("button", { type: "button", disabled: busy, onClick: goBack, style: { ...evBtnStyle(false), minHeight: 48 } }, '\u2190 Back'),
            step < EVENT_FORM_STEPS.length
                ? React.createElement("button", { type: "button", onClick: goNext, style: { ...evBtnStyle(true), minHeight: 48, flex: 1, borderRadius: RADIUS_SCALE[12] } }, 'Next \u2192')
                : React.createElement("button", { type: "button", disabled: busy, onClick: handleSave, style: { ...evBtnStyle(true), minHeight: 48, flex: 1, borderRadius: RADIUS_SCALE[12], opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : (initial ? 'Save draft' : 'Create draft')),
            React.createElement("button", { type: "button", onClick: onCancel, style: { ...evBtnStyle(false), minHeight: 48, marginLeft: step === 1 ? 'auto' : 0 } }, 'Cancel')));
}
