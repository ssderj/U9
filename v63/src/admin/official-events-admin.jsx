import React, { useEffect, useMemo, useState } from 'react';
import { EventCard } from '../guild/guild-event-card.jsx';
import { evBtnStyle, evInputStyle } from '../guild/guild-event-ui.jsx';
import {
    adminCancelGuildEventDispute, closeOfficialEvent, createOfficialEvent, fetchInkrootQuizBank, fetchOfficialEvents,
    settleOfficialEvent,
} from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Official Inkroot quizzes and tournaments (migration 185). Open to everyone on Inkroot; free unless an entry
// fee is set here; the prize comes from Inkroot's prize reserve. Inkroot admins can't play them. The limits
// below mirror the server's (guild_quiz_min_questions / guild_quiz_question_cap / guild_tournament_*), which
// re-checks everything — these only save an admin a round trip.
const LIMITS = {
    reading_challenge: { min: 15, max: 40, noun: 'quiz', maxPlace: 10 },
    tournament: { min: 15, max: 50, noun: 'tournament', maxPlace: 3 },
};
const DEFAULT_SPLIT = [{ place: 1, sharePct: '50' }, { place: 2, sharePct: '30' }, { place: 3, sharePct: '20' }];

const labelStyle = { fontSize: TYPE_SCALE[10.5], color: '#8A8A92', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const box = { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 12, marginBottom: 16 };

function Field({ label, children }) {
    return React.createElement("div", null, React.createElement("label", { style: labelStyle }, label), children);
}

function OfficialEventForm({ onCreated }) {
    const [type, setType] = useState('reading_challenge');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [rules, setRules] = useState('');
    const [prize, setPrize] = useState('');
    const [fee, setFee] = useState('');
    const [endDate, setEndDate] = useState('');
    const [limit, setLimit] = useState('');
    const [seconds, setSeconds] = useState('600');
    const [rounds, setRounds] = useState('5');
    const [split, setSplit] = useState(DEFAULT_SPLIT);
    const [bank, setBank] = useState(null);
    const [picked, setPicked] = useState(() => new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const lim = LIMITS[type];
    useEffect(() => { fetchInkrootQuizBank('approved').then(setBank); }, []);
    useEffect(() => { // a tournament pays 1st-3rd only
        setSplit((rows) => rows.filter((r) => r.place <= lim.maxPlace));
    }, [type, lim.maxPlace]);

    const total = useMemo(() => split.reduce((n, r) => n + (Number(r.sharePct) || 0), 0), [split]);
    const togglePick = (id) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else if (next.size < lim.max) next.add(id);
        return next;
    });

    const problem = (() => {
        if (!title.trim()) return 'Give the event a title.';
        if (!(Number(prize) > 0)) return 'Enter the cash prize.';
        if (fee !== '' && !(Number(fee) > 0)) return 'The entry fee must be more than zero — leave it empty for a free event.';
        if (!endDate || new Date(endDate).getTime() <= Date.now()) return 'Choose an end date in the future.';
        if (Math.abs(total - 100) > 0.001) return `The prize shares add up to ${total}% — they must total 100%.`;
        if (picked.size < lim.min) return `Pick at least ${lim.min} questions (${picked.size} picked).`;
        return null;
    })();

    const submit = async () => {
        setBusy(true);
        setError(null);
        try {
            await createOfficialEvent({
                eventType: type, title: title.trim(), description: description.trim(), rules: rules.trim(),
                cashPrizeNaira: Number(prize), entryFeeNaira: fee === '' ? null : Number(fee),
                endDate: new Date(endDate).toISOString(),
                placementSplit: split.map((r) => ({ place: r.place, sharePct: Number(r.sharePct) })),
                questionIds: [...picked], quizTimeLimitSeconds: Number(seconds), tournamentRounds: Number(rounds),
                participantLimit: limit === '' ? null : Number(limit),
            });
            onCreated();
        } catch (e) {
            setError(e.message || 'Could not create that event.');
        } finally {
            setBusy(false);
        }
    };

    const row = { display: 'grid', gap: SPACE_SCALE[8] };
    return React.createElement("div", { style: { ...row, marginTop: 10 } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            [['reading_challenge', 'Quiz'], ['tournament', 'Tournament']].map(([v, l]) => React.createElement("button", {
                key: v, onClick: () => { setType(v); setPicked(new Set()); }, style: evBtnStyle(type === v),
            }, l))),
        React.createElement(Field, { label: 'Title' }, React.createElement("input", { value: title, maxLength: 200, onChange: (e) => setTitle(e.target.value), style: evInputStyle })),
        React.createElement(Field, { label: 'Description (optional)' }, React.createElement("textarea", { value: description, onChange: (e) => setDescription(e.target.value), rows: 2, style: evInputStyle })),
        React.createElement(Field, { label: 'Rules (optional)' }, React.createElement("textarea", { value: rules, onChange: (e) => setRules(e.target.value), rows: 2, style: evInputStyle })),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement(Field, { label: 'Cash prize (\u20a6)' }, React.createElement("input", { type: 'number', min: '1', value: prize, onChange: (e) => setPrize(e.target.value), style: evInputStyle })),
            React.createElement(Field, { label: 'Entry fee (\u20a6) \u2014 empty = free' }, React.createElement("input", { type: 'number', min: '1', value: fee, onChange: (e) => setFee(e.target.value), style: evInputStyle }))),
        React.createElement(Field, { label: type === 'tournament' ? 'Entries close' : 'Quiz closes' },
            React.createElement("input", { type: 'datetime-local', value: endDate, onChange: (e) => setEndDate(e.target.value), style: evInputStyle })),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            type === 'reading_challenge'
                ? React.createElement(Field, { label: 'Time limit (seconds)' }, React.createElement("input", { type: 'number', min: '30', max: '7200', value: seconds, onChange: (e) => setSeconds(e.target.value), style: evInputStyle }))
                : React.createElement(Field, { label: 'Rounds (4\u20136)' }, React.createElement("input", { type: 'number', min: '4', max: '6', value: rounds, onChange: (e) => setRounds(e.target.value), style: evInputStyle })),
            React.createElement(Field, { label: 'Player limit (optional)' }, React.createElement("input", { type: 'number', min: '2', value: limit, onChange: (e) => setLimit(e.target.value), style: evInputStyle }))),
        React.createElement("div", null,
            React.createElement("label", { style: labelStyle }, `Prize split \u2014 ${total}% of 100%`),
            split.map((r, i) => React.createElement("div", { key: r.place, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6, alignItems: 'center' } },
                React.createElement("span", { style: { width: 40, fontSize: TYPE_SCALE[12], color: '#B5B0A5' } }, `#${r.place}`),
                React.createElement("input", {
                    type: 'number', min: '0', max: '100', value: r.sharePct, style: { ...evInputStyle, width: 90 },
                    onChange: (e) => setSplit((rows) => rows.map((x, xi) => xi === i ? { ...x, sharePct: e.target.value } : x)),
                }),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#84848C' } }, '%'),
                r.place > 1 && React.createElement("button", { onClick: () => setSplit((rows) => rows.filter((_, xi) => xi !== i)), style: { ...evBtnStyle(false), padding: '3px 8px' } }, '\u00d7'))),
            split.length < lim.maxPlace && React.createElement("button", {
                onClick: () => setSplit((rows) => [...rows, { place: rows.length ? Math.max(...rows.map((x) => x.place)) + 1 : 1, sharePct: '0' }]),
                style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' },
            }, '+ Add place')),
        React.createElement("div", null,
            React.createElement("label", { style: labelStyle }, `Questions \u2014 ${picked.size} picked (${lim.min}\u2013${lim.max} for a ${lim.noun})`),
            bank === null
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#84848C' } }, 'Opening the official bank\u2026')
                : bank.length === 0
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A' } }, 'No approved official questions yet \u2014 add and approve some in the official question bank first.')
                    : React.createElement("div", { style: { maxHeight: 260, overflowY: 'auto', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 6 } },
                        bank.map((q) => React.createElement("label", { key: q.id, style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'flex-start', padding: '5px 4px', fontSize: TYPE_SCALE[11.5], color: '#D9D2BE', cursor: 'pointer' } },
                            React.createElement("input", { type: 'checkbox', checked: picked.has(q.id), disabled: !picked.has(q.id) && picked.size >= lim.max, onChange: () => togglePick(q.id) }),
                            React.createElement("span", null, q.text))))),
        (error || problem) && React.createElement("div", { style: { color: error ? '#D98A8A' : '#8A8A92', fontSize: TYPE_SCALE[11] } }, error || problem),
        React.createElement("button", { disabled: busy || !!problem, onClick: submit, style: { ...evBtnStyle(true), opacity: (busy || problem) ? 0.5 : 1 } }, busy ? 'Creating\u2026' : 'Create official event'));
}

function OfficialEventRow({ event, onChanged }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [confirm, setConfirm] = useState(null); // 'settle' | 'cancel'
    const [reason, setReason] = useState('');

    const run = async (fn) => {
        setBusy(true);
        setError(null);
        try { await fn(); setConfirm(null); onChanged(); }
        catch (e) { setError(e.message || 'That did not go through.'); onChanged(); }
        finally { setBusy(false); }
    };
    const open = event.status === 'open' && event.approval_status === 'active';
    const over = event.status === 'closed' && event.approval_status === 'completed';
    const done = event.status === 'settled' || event.status === 'cancelled';

    return React.createElement("div", { style: { marginBottom: 12 } },
        // The same card readers see (entry, play and results all work from it); admins can't play, and the card says so.
        React.createElement(EventCard, { event, isOwner: false, members: [], onChanged, onEdit: () => {}, isAdmin: true }),
        !done && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginTop: -2, marginBottom: 6 } },
            open && React.createElement("button", { disabled: busy, onClick: () => run(() => closeOfficialEvent(event.id)), style: evBtnStyle(false) },
                event.event_type === 'tournament' ? 'Close entries & start' : 'End quiz now'),
            over && React.createElement("button", { disabled: busy, onClick: () => setConfirm('settle'), style: evBtnStyle(true) }, 'Work out winners & pay'),
            (open || over) && React.createElement("button", { disabled: busy, onClick: () => setConfirm('cancel'), style: evBtnStyle(false) }, 'Cancel event')),
        // Migration 187: a quiz pays itself (checked every 15 minutes, once nobody is still answering); this
        // button is only for paying sooner or if that ever fails. A tournament always waits for an admin.
        over && event.event_type === 'reading_challenge' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A8A92', fontStyle: 'italic', marginBottom: 6 } },
            'This quiz pays its winners automatically shortly after everyone has finished. Use the button only to pay sooner.'),
        confirm === 'settle' && React.createElement("div", { style: { ...box, marginBottom: 6 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D9D2BE', marginBottom: 8 } },
                `This ranks the players exactly as a guild event does and pays ${formatNaira(event.cashPrizeNaira)} from the prize reserve into the winners\u2019 balances. It can\u2019t be undone. For a tournament, take a look at any matches marked \u201cworth a look\u201d first.`),
            React.createElement("button", { disabled: busy, onClick: () => run(() => settleOfficialEvent(event.id)), style: evBtnStyle(true) }, busy ? '\u2026' : 'Yes, pay the winners')),
        confirm === 'cancel' && React.createElement("div", { style: { ...box, marginBottom: 6 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D9D2BE', marginBottom: 8 } },
                'Cancelling returns the prize to the reserve. Anyone who paid an entry fee is refunded through the usual dispute process.'),
            React.createElement("input", { value: reason, onChange: (e) => setReason(e.target.value), placeholder: 'Reason (shown to entrants)', style: { ...evInputStyle, marginBottom: 8 } }),
            React.createElement("button", { disabled: busy || !reason.trim(), onClick: () => run(() => adminCancelGuildEventDispute(event.id, reason.trim())), style: { ...evBtnStyle(true), opacity: (busy || !reason.trim()) ? 0.5 : 1 } }, busy ? '\u2026' : 'Cancel this event')),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5] } }, error));
}

export function OfficialEventsAdmin() {
    const [open, setOpen] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [events, setEvents] = useState(null);
    const load = () => fetchOfficialEvents().then(setEvents).catch(() => setEvents([]));
    useEffect(() => { if (open) load(); }, [open]);

    return React.createElement("div", { style: box },
        React.createElement("button", { onClick: () => setOpen((v) => !v), style: { display: 'flex', justifyContent: 'space-between', width: '100%', background: 'none', border: 'none', color: '#EFE7D2', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', padding: 0 } },
            React.createElement("span", null, 'Official quizzes & tournaments'),
            React.createElement("span", { style: { color: '#8A8A92' } }, open ? '\u2212' : '+')),
        open && React.createElement("div", { style: { marginTop: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#84848C', fontStyle: 'italic', marginBottom: 10 } },
                'Open to everyone. Free unless you set an entry fee. The prize is paid from the Inkroot prize reserve. Inkroot admins can\u2019t play these.'),
            !showForm && React.createElement("button", { onClick: () => setShowForm(true), style: evBtnStyle(true) }, '+ New official event'),
            showForm && React.createElement(OfficialEventForm, { onCreated: () => { setShowForm(false); load(); } }),
            showForm && React.createElement("button", { onClick: () => setShowForm(false), style: { ...evBtnStyle(false), marginTop: 8 } }, 'Cancel'),
            React.createElement("div", { style: { marginTop: 14 } },
                events === null
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#84848C', textAlign: 'center' } }, 'Opening\u2026')
                    : events.length === 0
                        ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#84848C', textAlign: 'center' } }, 'No official quizzes or tournaments yet.')
                        : events.map((ev) => React.createElement(OfficialEventRow, { key: ev.id, event: ev, onChanged: load })))));
}
