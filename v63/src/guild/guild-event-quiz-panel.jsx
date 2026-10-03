import { S, SERIF, pillStyle, srOnly } from './guild-styles.js';
import { C, goldA, dangerA, urgencyColor } from './guild-theme.js';
import React, { useEffect, useRef, useState } from 'react';
import {
    fetchGuildQuizQuestionsForHost, fetchMyGuildEventResult, fetchMyGuildQuizAttempt, fetchMyGuildQuizSuggestions,
    hostAddGuildQuizQuestion, removeGuildQuizQuestion, reviewGuildQuizQuestion, setGuildQuizSettings,
    startGuildQuizAttempt, submitGuildQuizAttempt, suggestGuildQuizQuestion,
} from '../lib/guild-events.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { formatNaira } from '../lib/payments.js';
import { evBtnStyle, evInputStyle, formatEventDate } from './guild-event-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// ---------------------------------------------------------------------------------------------
// Reading Events & Trivia — backend shipped in 172_migration_quiz_backend.sql and is live. What the server does, and therefore what this file must NOT do:
//   * Answer keys never leave the server. Entrants get questions + options only
//     (start_guild_quiz_attempt); only the host (list_guild_quiz_questions_for_host) and a question's
//     own writer (list_my_guild_quiz_suggestions) can read a key.
//   * Grading and timing are the server's. One overall time limit per attempt, started and measured
//     by the server; a refresh resumes the same attempt; one attempt per entrant. The countdown the
//     player shows is only a courtesy built from the server's remaining time — a late submit is
//     refused no matter what this screen says. gradeQuiz() below is for previews only.
//   * Score = correct answers, ties go to the fastest server-measured time. Placements come from
//     compute_guild_event_placements (host or Inkroot presses compute; a quiz has no judges).
//   * Members of the hosting guild suggest questions (the host reviews); the question set freezes when
//     the event opens; a writer can't enter the quiz they wrote for. Caps and the minimum number of
//     approved questions are the server's numbers — this file shows counts and the server's own
//     error message instead of restating them.
//
// Trivia: this is a reading_challenge with the source set to "No book" (there is no separate
// 'trivia' event_type in the DB).
// ---------------------------------------------------------------------------------------------
// Decision: the source book always comes from the guild's own anthology (or no book, for trivia);
// questions are polls only (tap-the-right-option, graded automatically). Open-answer questions and
// the other book pools were dropped to keep this simple.
export const SOURCE_POOLS = {
    anthology: 'This guild\u2019s anthology',
    none: 'No book \u2014 trivia',
};

// Shared fragments live in guild-styles.js; these names are kept so every use below reads the same.
const qzLabelStyle = S.capsLabel;
const qzCardStyle = S.card;

// ---------- Shared look (UI only: nothing in this block touches grading, timing or the server) ----------
// qzBtnStyle is evBtnStyle with a 44px touch target. It is local on purpose: evBtnStyle is used by every
// event screen, and the host controls here (Approve / Reject / Remove / mark-correct) were the ones that
// fell under a comfortable tap size on a phone.
export const qzBtnStyle = (primary) => ({ ...evBtnStyle(primary), minHeight: 44 });
const qzSerif = SERIF;
const qzPill = (color) => pillStyle(color, 9);
const OPTION_LETTERS = 'ABCDEF';
const qzSrOnly = srOnly;

// A small stat tile (label over value), used on the pre-start screen.
function QuizStatChip({ label, value }) {
    return React.createElement("div", { style: { flex: 1, minWidth: 0, textAlign: 'center', padding: '8px 6px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8] } },
        React.createElement("div", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[15], fontWeight: 600, color: C.textStrong } }, value),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 } }, label));
}

// A circular score read-out. Purely a drawing of numbers the server already returned.
function QuizScoreRing({ score, total }) {
    const r = 30, circ = 2 * Math.PI * r;
    const frac = total > 0 ? Math.max(0, Math.min(1, score / total)) : 0;
    return React.createElement("div", { style: { position: 'relative', width: 76, height: 76, flexShrink: 0 }, role: "img", "aria-label": `${score} of ${total} correct` },
        React.createElement("svg", { width: 76, height: 76, viewBox: "0 0 76 76", "aria-hidden": "true" },
            React.createElement("circle", { cx: 38, cy: 38, r, fill: 'none', stroke: C.border, strokeWidth: 6 }),
            React.createElement("circle", { cx: 38, cy: 38, r, fill: 'none', stroke: C.goldBright, strokeWidth: 6, strokeLinecap: 'round', strokeDasharray: `${frac * circ} ${circ}`, transform: 'rotate(-90 38 38)' })),
        React.createElement("div", { style: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', lineHeight: 1.1 } },
            React.createElement("span", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[17], fontWeight: 600, color: C.textStrong } }, score),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft } }, `of ${total}`)));
}

// Shown when a submit failed and the answers are being held on screen. Same button and handler as before,
// just impossible to miss while a clock may still be running.
export function QuizRetryBanner({ busy, onRetry }) {
    return React.createElement("div", { role: "alert", style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], padding: '10px 12px', marginBottom: 12, borderRadius: RADIUS_SCALE[12], background: dangerA(0.08), border: `1px solid ${C.danger}66` } },
        React.createElement(InkIcon, { name: 'alert', size: 20, color: C.danger }),
        React.createElement("div", { style: { flex: 1, minWidth: 0, fontSize: TYPE_SCALE[13], color: C.text, lineHeight: 1.4 } }, 'Your answers haven\u2019t been sent yet.'),
        React.createElement("button", { disabled: busy, onClick: onRetry, style: { ...qzBtnStyle(true), minHeight: 48, opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Retry submit'));
}

// A checklist the host can read at a glance. Items are derived from state the section already holds.
export function QuizSetupChecklist({ items }) {
    return React.createElement("ul", { style: { listStyle: 'none', margin: '0 0 10px', padding: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
        items.map((it) => React.createElement("li", { key: it.label, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[13], color: it.ok ? C.text : C.textSoft } },
            React.createElement("span", { "aria-hidden": "true", style: { width: 18, height: 18, borderRadius: RADIUS_SCALE[999], flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                color: it.ok ? C.brown : C.textSoft, background: it.ok ? C.success : 'transparent', border: `1px solid ${it.ok ? C.success : C.border}` } }, it.ok ? React.createElement(InkIcon, { name: 'check', size: 12, strokeWidth: 3 }) : null),
            React.createElement("span", null, it.ok ? it.label : `${it.label} \u2014 still to do`))));
}

// Long rule text lives behind a native disclosure so the form stays short. Same words as before.
export function QuizHowItWorks({ title, children }) {
    return React.createElement("details", { style: { marginBottom: 10, background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], padding: '0 10px' } },
        React.createElement("summary", { style: { cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center', fontSize: TYPE_SCALE[13], color: C.textDim } }, title),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, lineHeight: 1.5, padding: '0 0 10px' } }, children));
}

let qzSeq = 0;
const qzId = () => `q${Date.now().toString(36)}${(qzSeq += 1)}`;
const newQuestion = (type) => ({
    id: qzId(), type, text: '',
    options: type === 'poll' ? [{ id: qzId(), text: '' }, { id: qzId(), text: '' }] : [],
    correctOptionId: null, correctAnswer: '',
});

// Returns an error string or null.
function validateQuiz(questions) {
    if (!questions || questions.length === 0) return 'Add at least one question.';
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const n = i + 1;
        if (!q.text.trim()) return `Question ${n} needs some text.`;
        if (q.type === 'poll') {
            const filled = q.options.filter((o) => o.text.trim());
            if (filled.length < 2) return `Question ${n} needs at least two options.`;
            if (!q.correctOptionId || !filled.some((o) => o.id === q.correctOptionId)) return `Mark the correct option for question ${n}.`;
        } else if (!q.correctAnswer.trim()) {
            return `Question ${n} needs its correct answer.`;
        }
    }
    return null;
}

// PREVIEW ONLY — see BACKEND FLAG 2. Open answers: case-insensitive, trimmed, per the spec.
function gradeQuiz(questions, answers) {
    return questions.reduce((score, q) => {
        const a = answers[q.id];
        if (a == null) return score;
        if (q.type === 'poll') return score + (a === q.correctOptionId ? 1 : 0);
        return score + (String(a).trim().toLowerCase() === q.correctAnswer.trim().toLowerCase() ? 1 : 0);
    }, 0);
}

const formatSeconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const ordinal = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const formatClock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const formatLimit = (sec) => (sec < 120 ? `${sec} seconds` : `${Math.round(sec / 60)} minutes`);

// ---------- Entrant quiz player: one question at a time, timing each ----------
// Optional strict mode (used by tournament reading rounds \u2014 see the anti-cheat proposal in the
// redesign spec, all of it flagged v1 / best-effort): timeLimitSec adds a soft per-question timer
// that moves on by itself when it runs out; trackFocus counts window-blur events and returns them
// as tabSwitches; shuffleOptions randomizes poll option order per question. There is never a way
// back to an earlier question. None of this is a security boundary \u2014 it all runs on the client
// (a determined cheater with a second device gets around it) \u2014 and tabSwitches is a soft signal
// for officers to review, never an automatic disqualification, so it must be recorded server-side
// to be of any use (BACKEND FLAG 3 above).
function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// deadlineMs (optional, used by the real quiz): an absolute client time at which the attempt's ONE
// overall limit runs out — the player then submits whatever is answered. It is built from the
// server's remaining time, and the server still has the final say.
// Answers and position are mirrored to sessionStorage under `saveKey` so a reload, a killed phone tab or a
// Back press mid-quiz resumes where the reader was instead of at question 1 with every answer gone (the
// server clock keeps running either way). Cleared by the caller once the attempt is submitted.
function readSavedQuiz(saveKey, questions) {
    if (!saveKey) return { index: 0, answers: {} };
    try {
        const raw = JSON.parse(sessionStorage.getItem(saveKey) || 'null');
        if (!raw || typeof raw.index !== 'number') return { index: 0, answers: {} };
        return { index: Math.min(Math.max(0, raw.index), Math.max(0, questions.length - 1)), answers: raw.answers || {} };
    }
    catch (e) { return { index: 0, answers: {} }; }
}
export function clearSavedQuiz(saveKey) { try { if (saveKey) sessionStorage.removeItem(saveKey); } catch (e) { } }

export function QuizPlayer({ questions, onFinish, busy, timeLimitSec, trackFocus, shuffleOptions, deadlineMs, saveKey }) {
    if (!questions || questions.length === 0)
        return React.createElement("div", { style: qzCardStyle, role: "alert" }, 'This quiz has no questions to show.');
    return React.createElement(QuizPlayerInner, { questions, onFinish, busy, timeLimitSec, trackFocus, shuffleOptions, deadlineMs, saveKey });
}

function QuizPlayerInner({ questions, onFinish, busy, timeLimitSec, trackFocus, shuffleOptions, deadlineMs, saveKey }) {
    const saved = useRef(null);
    if (saved.current === null) saved.current = readSavedQuiz(saveKey, questions);
    const [index, setIndex] = useState(saved.current.index);
    const [answers, setAnswers] = useState(saved.current.answers);
    useEffect(() => {
        if (!saveKey) return;
        try { sessionStorage.setItem(saveKey, JSON.stringify({ index, answers })); } catch (e) { }
    }, [saveKey, index, answers]);
    const [remaining, setRemaining] = useState(timeLimitSec || null);
    const [overallLeft, setOverallLeft] = useState(deadlineMs ? Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)) : null);
    const answersRef = useRef({});
    answersRef.current = answers;
    // Starting value of the overall clock, kept only to draw how much of it is left (display, not timing).
    const overallTotalRef = useRef(overallLeft);
    const totalRef = useRef(0);
    const shownAtRef = useRef(Date.now());
    const tabSwitchesRef = useRef(0);
    const finishedRef = useRef(false);
    const optionOrderRef = useRef({});
    const q = questions[index];
    const isLast = index === questions.length - 1;
    const current = answers[q.id];
    const canAdvance = q.type === 'poll' ? !!current : !!(current && String(current).trim());

    if (shuffleOptions && q.type === 'poll' && !optionOrderRef.current[q.id]) {
        optionOrderRef.current[q.id] = shuffled(q.options.filter((o) => o.text.trim()));
    }
    const optionsToShow = q.type === 'poll'
        ? (shuffleOptions ? optionOrderRef.current[q.id] : q.options.filter((o) => o.text.trim()))
        : [];

    useEffect(() => { shownAtRef.current = Date.now(); }, [index]);

    useEffect(() => {
        if (!trackFocus) return undefined;
        // visibilitychange (page actually hidden), not window 'blur': blur also fires for the on-screen keyboard,
        // the notification shade and tapping into an iframe, which counted honest phone players as tab switches.
        const onHide = () => { if (document.hidden) tabSwitchesRef.current += 1; };
        document.addEventListener('visibilitychange', onHide);
        return () => document.removeEventListener('visibilitychange', onHide);
    }, [trackFocus]);

    const finishOrNext = (finalAnswers) => {
        if (finishedRef.current) return;
        totalRef.current += Date.now() - shownAtRef.current;
        if (index < questions.length - 1) { setIndex((i) => i + 1); return; }
        finishedRef.current = true;
        onFinish({ answers: finalAnswers, totalTimeMs: totalRef.current, tabSwitches: tabSwitchesRef.current });
    };

    const finishNow = (finalAnswers) => {
        if (finishedRef.current) return;
        totalRef.current += Date.now() - shownAtRef.current;
        finishedRef.current = true;
        onFinish({ answers: finalAnswers, totalTimeMs: totalRef.current, tabSwitches: tabSwitchesRef.current });
    };
    const finishNowRef = useRef(finishNow);
    finishNowRef.current = finishNow;

    useEffect(() => {
        if (!deadlineMs) return undefined;
        const t = setInterval(() => {
            const left = Math.ceil((deadlineMs - Date.now()) / 1000);
            setOverallLeft(Math.max(0, left));
            if (left <= 0) { clearInterval(t); finishNowRef.current(answersRef.current); }
        }, 500);
        return () => clearInterval(t);
    }, [deadlineMs]);

    useEffect(() => {
        if (!timeLimitSec) return undefined;
        setRemaining(timeLimitSec);
        const start = Date.now();
        const t = setInterval(() => {
            const left = timeLimitSec - Math.floor((Date.now() - start) / 1000);
            setRemaining(Math.max(0, left));
            if (left <= 0) { clearInterval(t); finishOrNext(answersRef.current); }
        }, 500);
        return () => clearInterval(t);
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [index, timeLimitSec]);

    // ---- Presentation only: everything above (timers, answers, finishing) is unchanged. ----
    const clockLeft = overallLeft != null ? overallLeft : remaining;
    const clockTotal = overallLeft != null ? overallTotalRef.current : timeLimitSec;
    const clockFrac = clockLeft != null && clockTotal ? Math.max(0, Math.min(1, clockLeft / clockTotal)) : null;
    const clockTone = urgencyColor(clockLeft);
    const clockLabel = overallLeft != null ? formatClock(overallLeft) : (remaining != null ? `${remaining}s` : 'Timed');
    // Spoken only when the bucket changes, so a screen reader hears three short warnings, not a tick per second.
    const announce = clockLeft == null ? '' : clockLeft <= 10 ? '10 seconds left' : clockLeft <= 30 ? '30 seconds left' : clockLeft <= 60 ? 'One minute left' : '';
    const manyQuestions = questions.length > 12;

    return React.createElement("div", { className: "ik-ev", style: { ...qzCardStyle, padding: 14, position: 'relative' } },
        React.createElement("div", { style: { position: 'sticky', top: 0, zIndex: 2, background: C.panel, margin: '-14px -14px 10px', padding: '12px 14px 8px', borderRadius: `${RADIUS_SCALE[8]}px ${RADIUS_SCALE[8]}px 0 0`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[8] } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft } }, `Question ${index + 1} of ${questions.length}`),
            React.createElement("span", { role: "timer", "aria-live": "off", "aria-label": `Time left ${clockLabel}`, style: {
                position: 'relative', overflow: 'hidden', display: 'inline-flex', alignItems: 'center', minWidth: 64, justifyContent: 'center',
                padding: '4px 12px 7px', borderRadius: RADIUS_SCALE[100], border: `1px solid ${clockTone}66`, background: `${clockTone}14`,
                fontSize: TYPE_SCALE[15], fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: clockTone, transition: 'color var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease)',
            } },
                clockLabel,
                clockFrac != null && React.createElement("span", { "aria-hidden": "true", style: { position: 'absolute', left: 0, bottom: 0, height: 3, width: `${clockFrac * 100}%`, background: clockTone, transition: 'width 600ms linear, background var(--ink-dur) var(--ink-ease)' } }))),
        React.createElement("div", { "aria-live": "polite", style: qzSrOnly }, announce),
        // Progress: one segment per question (a single bar past 12 so it never turns into confetti).
        manyQuestions
            ? React.createElement("div", { "aria-hidden": "true", style: { height: 4, borderRadius: RADIUS_SCALE[100], background: C.border, marginBottom: 14, overflow: 'hidden' } },
                React.createElement("div", { style: { height: '100%', width: `${(index / questions.length) * 100}%`, background: C.textMuted, transition: 'width var(--ink-dur) var(--ink-ease)' } }))
            : React.createElement("div", { "aria-hidden": "true", style: { display: 'flex', gap: SPACE_SCALE[4], marginBottom: 14 } },
                questions.map((x, i) => React.createElement("span", { key: x.id, style: { flex: 1, height: 4, borderRadius: RADIUS_SCALE[100], background: i < index ? C.textMuted : (i === index ? C.goldBright : C.border), transition: 'background var(--ink-dur) var(--ink-ease)' } }))),
        // Keyed by question so each new question fades in with the app's shared card-in motion (reduced-motion safe).
        React.createElement("div", { key: q.id, className: "ai-card-in" },
            React.createElement("div", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[17], lineHeight: 1.4, color: C.textStrong, marginBottom: 14 } }, q.text),
            q.type === 'poll'
                ? React.createElement("div", { role: "radiogroup", "aria-label": q.text, style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8], marginBottom: 14 } },
                    optionsToShow.map((o, oi) => {
                        const sel = current === o.id;
                        return React.createElement("button", {
                            key: o.id, type: "button", role: "radio", "aria-checked": sel, onClick: () => setAnswers((a) => ({ ...a, [q.id]: o.id })),
                            style: {
                                ...evBtnStyle(sel), display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], textAlign: 'left', minHeight: 52, fontSize: TYPE_SCALE[13], padding: '10px 14px',
                                color: sel ? C.textStrong : C.text, borderRadius: RADIUS_SCALE[12], border: `1px solid ${sel ? C.textBright : C.border}`, background: sel ? C.surfaceWarm : 'transparent', boxShadow: sel ? `0 0 0 1px ${C.textBright}55` : 'none',
                                transition: 'background var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease)',
                            },
                        },
                            React.createElement("span", { "aria-hidden": "true", style: {
                                width: 28, height: 28, borderRadius: RADIUS_SCALE[999], flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                fontSize: TYPE_SCALE[13], fontWeight: 700, color: sel ? C.brown : C.textSoft, background: sel ? C.textBright : 'transparent', border: `1px solid ${sel ? C.textBright : C.borderStrong}`,
                                transition: 'background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease)',
                            } }, OPTION_LETTERS[oi] || oi + 1),
                            React.createElement("span", { style: { flex: 1, minWidth: 0, lineHeight: 1.4 } }, o.text));
                    }))
                : React.createElement("input", {
                    value: current || '', onChange: (e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value })),
                    placeholder: 'Type your answer', style: { ...evInputStyle, minHeight: 48, fontSize: TYPE_SCALE[13], marginBottom: 14 },
                })),
        // Pinned to the bottom of the screen so the main action stays under the thumb on a long question.
        React.createElement("div", { style: { position: 'sticky', bottom: 0, zIndex: 2, background: C.panel, margin: '0 -14px -14px', padding: `10px 14px calc(14px + env(safe-area-inset-bottom, 0px))`, borderTop: `1px solid ${C.border}`, borderRadius: `0 0 ${RADIUS_SCALE[8]}px ${RADIUS_SCALE[8]}px` } },
            React.createElement("button", { disabled: !canAdvance || busy, onClick: () => finishOrNext(answers), style: { ...evBtnStyle(true), minHeight: 52, width: '100%', fontSize: TYPE_SCALE[13], borderRadius: RADIUS_SCALE[12], opacity: (!canAdvance || busy) ? 0.5 : 1 } },
                busy ? '\u2026' : (isLast ? 'Submit answers' : 'Continue')),
            // The "no going back" rule is explained once, before the quiz starts; here only the irreversible final step repeats it.
            isLast && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textMuted, textAlign: 'center', marginTop: 8 } }, 'Answers are final once you submit.')));
}

// ---------- Host: source-book picker (real read-only lookups) ----------
export function BookPicker({ pool, guildId, members, value, onPick }) {
    const [items, setItems] = useState(undefined);
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        setItems(undefined);
        setError(null);
        const job = fetchGuildAnthologies(guildId).then((rows) => rows.map((r) => ({ id: r.id, title: r.title, sub: r.status })));
        job.then((rows) => { if (!cancelled) setItems(rows); }).catch((e) => { if (!cancelled) { setError(e.message || 'Could not load books.'); setItems([]); } });
        return () => { cancelled = true; };
    }, [pool, guildId]);

    const shown = (items || []).filter((b) => !query.trim() || b.title.toLowerCase().includes(query.trim().toLowerCase()));
    return React.createElement("div", null,
        React.createElement("input", { value: query, onChange: (e) => setQuery(e.target.value), placeholder: 'Search by title', style: { ...evInputStyle, marginBottom: 6 } }),
        items === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger } }, error),
        items && items.length === 0 && !error && React.createElement("div", { style: S.noteItalic },
            'This guild has no anthologies yet.'),
        React.createElement("div", { style: { maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
            shown.slice(0, 50).map((b) => React.createElement("button", {
                key: b.id, onClick: () => onPick({ id: b.id, title: b.title }),
                style: { ...evBtnStyle(value && value.id === b.id), textAlign: 'left' },
            }, b.sub ? `${b.title} \u2014 ${b.sub}` : b.title))));
}


// ---------- One poll question, written by a host or a member ----------
// Polls only: 2-6 options, one marked correct. Validation here is a courtesy (the server checks the
// same things again and its message is what's shown if it disagrees).
export function QuizQuestionForm({ onSubmit, submitLabel, busy }) {
    const [q, setQ] = useState(() => newQuestion('poll'));
    const [problem, setProblem] = useState(null);
    const update = (patch) => setQ((cur) => ({ ...cur, ...patch }));

    const submit = async () => {
        const err = validateQuiz([q]);
        setProblem(err);
        if (err) return;
        try {
            await onSubmit(q);
            setQ(newQuestion('poll'));
        } catch (e) {
            setProblem(e.message || 'Could not save this question.');
        }
    };

    return React.createElement("div", { style: qzCardStyle },
        React.createElement("input", { value: q.text, onChange: (e) => update({ text: e.target.value }), placeholder: 'Question', "aria-label": 'Question', style: { ...evInputStyle, minHeight: 44, marginBottom: 6 } }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginBottom: 8 } }, 'Tap the circle beside an option to mark it as the correct answer.'),
        React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
            q.options.map((o, oi) => React.createElement("div", { key: o.id, style: { display: 'flex', gap: SPACE_SCALE[6], alignItems: 'center' } },
                React.createElement("button", {
                    type: "button", title: 'Mark as correct', "aria-label": `Mark option ${oi + 1} as correct`, "aria-pressed": q.correctOptionId === o.id, onClick: () => update({ correctOptionId: o.id }),
                    style: { ...qzBtnStyle(q.correctOptionId === o.id), minWidth: 44, padding: 0, flexShrink: 0 },
                }, q.correctOptionId === o.id ? React.createElement(IconText, { icon: 'check', size: 18, strokeWidth: 2.4 }) : React.createElement(IconText, { icon: 'circle', size: 18 })),
                React.createElement("input", {
                    value: o.text, placeholder: `Option ${oi + 1}`, "aria-label": `Option ${oi + 1}`, style: { ...evInputStyle, minHeight: 44 },
                    onChange: (e) => update({ options: q.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) }),
                }),
                q.options.length > 2 && React.createElement("button", {
                    type: "button", "aria-label": `Remove option ${oi + 1}`,
                    onClick: () => update({ options: q.options.filter((x) => x.id !== o.id), correctOptionId: q.correctOptionId === o.id ? null : q.correctOptionId }),
                    style: { background: 'none', border: 'none', color: C.textSoft, cursor: 'pointer', minWidth: 44, minHeight: 44, fontSize: TYPE_SCALE[17] },
                }, React.createElement(IconText, { icon: 'close', size: 18 })))),
            q.options.length < 6 && React.createElement("button", { onClick: () => update({ options: [...q.options, { id: qzId(), text: '' }] }), style: { ...qzBtnStyle(false), alignSelf: 'flex-start', padding: '4px 12px', fontSize: TYPE_SCALE[13] } }, '+ Add option')),
        problem && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger, marginTop: 8 } }, problem),
        React.createElement("button", { disabled: busy, onClick: submit, style: { ...qzBtnStyle(true), marginTop: 10, opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : submitLabel));
}

const QUESTION_STATUS_COLORS = { pending: C.gold, approved: C.success, rejected: C.danger };

export function QuizQuestionRow({ question, authorName, children }) {
    const statusColor = QUESTION_STATUS_COLORS[question.status] || C.neutralSoft;
    return React.createElement("div", { style: qzCardStyle },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 8 } },
            React.createElement("span", { style: qzPill(statusColor) }, question.status === 'pending' ? 'Awaiting review' : question.status),
            authorName && React.createElement("span", { style: S.noteSmall }, authorName)),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], lineHeight: 1.4, color: C.text, marginBottom: 8 } }, question.text),
        // Every option, with the correct one marked, so a host can review a question without decoding a dotted line.
        React.createElement("ul", { style: { listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
            question.options.map((o) => {
                const ok = o.id === question.correctOptionId;
                return React.createElement("li", { key: o.id, style: { display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[13], lineHeight: 1.4, color: ok ? C.success : C.textSoft } },
                    React.createElement("span", { "aria-hidden": "true", style: { width: 16, flexShrink: 0, textAlign: 'center', fontWeight: 700, display: 'inline-flex', justifyContent: 'center', paddingTop: 2 } }, ok ? React.createElement(InkIcon, { name: 'check', size: 14, strokeWidth: 2.4 }) : React.createElement(InkIcon, { name: 'circle', size: 12 })),
                    React.createElement("span", { style: { flex: 1, minWidth: 0 } }, o.text, ok && React.createElement("span", { style: qzSrOnly }, ' (correct answer)')));
            })),
        children);
}

// Two-step button for actions that can't be undone: the first tap asks, the second does it. It puts itself away
// after a few seconds so a stray tap never leaves a live "Yes, remove" lying around.
export function ConfirmButton({ label, confirmLabel = 'Yes', onConfirm, disabled, buttonStyle }) {
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        if (!armed) return undefined;
        const t = setTimeout(() => setArmed(false), 6000);
        return () => clearTimeout(t);
    }, [armed]);
    if (!armed) {
        return React.createElement("button", { type: "button", disabled, onClick: () => setArmed(true), style: buttonStyle }, label);
    }
    return React.createElement("span", { role: "group", "aria-label": `Confirm: ${label}`, style: { display: 'inline-flex', gap: SPACE_SCALE[8], alignItems: 'center', flexWrap: 'wrap' } },
        React.createElement("button", { type: "button", disabled, onClick: () => { setArmed(false); onConfirm(); }, style: { ...qzBtnStyle(false), color: C.danger, borderColor: dangerA(0.5) } }, confirmLabel),
        React.createElement("button", { type: "button", onClick: () => setArmed(false), style: qzBtnStyle(false) }, 'Cancel'));
}

// A small icon next to (or, with after, behind) a label, drawn from the app's own icon set instead of a typed glyph.
export function IconText({ icon, size = 14, strokeWidth, color, gap = 6, after, children, style }) {
    return React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap, verticalAlign: 'middle', flexDirection: after ? 'row-reverse' : 'row', ...style } },
        React.createElement(InkIcon, { name: icon, size, color, strokeWidth }),
        children != null && React.createElement("span", null, children));
}

// ---------- Host setup helpers (presentation only; shared with the tournament host section) ----------
// A row of equal-width choices that replaces a <select> when there are only a few options.
export function Segmented({ label, value, options, onChange, disabled }) {
    return React.createElement("div", { role: "radiogroup", "aria-label": label, style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
        options.map((o) => {
            const on = o.value === value;
            return React.createElement("button", { key: String(o.value), type: "button", role: "radio", "aria-checked": on, disabled: disabled && !on, onClick: () => { if (!disabled) onChange(o.value); },
                style: { ...evBtnStyle(on), flex: '1 1 0', minWidth: 96, minHeight: 52, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, textAlign: 'center', borderRadius: RADIUS_SCALE[12], opacity: disabled && !on ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13] } }, o.label),
                o.sub && React.createElement("span", { style: { fontSize: TYPE_SCALE[13], fontWeight: 400, color: on ? C.gold : C.textSoft } }, o.sub));
        }));
}

export function HostProgress({ value, max, label, tone }) {
    const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    const c = tone || (frac >= 1 ? C.success : C.gold);
    return React.createElement("div", null,
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[13], color: C.textSoft, marginBottom: 4 } },
            React.createElement("span", null, label),
            React.createElement("span", { style: { color: c, fontVariantNumeric: 'tabular-nums' } }, `${value} / ${max}`)),
        React.createElement("div", { role: "progressbar", "aria-valuemin": 0, "aria-valuemax": max, "aria-valuenow": Math.min(value, max), "aria-label": label, style: { height: 6, borderRadius: RADIUS_SCALE[100], background: C.border, overflow: 'hidden' } },
            React.createElement("div", { style: { height: '100%', width: `${frac * 100}%`, background: c, transition: 'width var(--ink-dur) var(--ink-ease)' } })));
}

// Sticky step bar: numbered steps with a tick once a step is ready, and a one-line readiness summary underneath.
export function HostStepper({ steps, step, onStep, ready, total }) {
    return React.createElement("div", { style: { position: 'sticky', top: 0, zIndex: 3, background: C.panel, margin: '-10px -10px 12px', padding: '10px 10px 8px', borderBottom: `1px solid ${C.border}`, borderRadius: `${RADIUS_SCALE[8]}px ${RADIUS_SCALE[8]}px 0 0` } },
        React.createElement("div", { role: "tablist", "aria-label": "Setup steps", style: { display: 'flex', gap: SPACE_SCALE[6] } },
            steps.map((st, i) => {
                const on = i === step;
                return React.createElement("button", { key: st.label, type: "button", role: "tab", "aria-selected": on, onClick: () => onStep(i),
                    style: { flex: 1, minWidth: 0, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], padding: '0 6px', borderRadius: RADIUS_SCALE[12], cursor: 'pointer', fontSize: TYPE_SCALE[13], fontWeight: on ? 700 : 500,
                        color: on ? C.goldBright : (st.done ? C.success : C.textSoft), background: on ? goldA(0.10) : 'transparent', border: `1px solid ${on ? goldA(0.5) : C.border}` } },
                    React.createElement("span", { "aria-hidden": "true", style: { width: 18, height: 18, flexShrink: 0, borderRadius: RADIUS_SCALE[999], display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                        color: st.done ? C.brown : (on ? C.goldBright : C.textSoft), background: st.done ? C.success : 'transparent', border: `1px solid ${st.done ? C.success : (on ? C.goldBright : C.borderStrong)}` } }, st.done ? React.createElement(InkIcon, { name: 'check', size: 11, strokeWidth: 3 }) : i + 1),
                    React.createElement("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st.label),
                    st.done && React.createElement("span", { style: qzSrOnly }, ' (ready)'));
            })),
        total > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: ready >= total ? C.success : C.textSoft, marginTop: 8 } },
            ready >= total ? React.createElement(IconText, { icon: 'check', size: 14, strokeWidth: 2.4 }, 'Ready to open') : `${ready} of ${total} things ready before you can open this event`));
}

// Back / Next buttons at the foot of a step.
export function HostStepNav({ step, last, labels, onStep }) {
    return React.createElement("div", { style: { ...S.row8, marginTop: 4 } },
        step > 0 && React.createElement("button", { type: "button", onClick: () => onStep(step - 1), style: { ...qzBtnStyle(false), flex: 1 } }, React.createElement(IconText, { icon: 'arrowLeft', size: 16 }, labels[step - 1])),
        step < last && React.createElement("button", { type: "button", onClick: () => onStep(step + 1), style: { ...qzBtnStyle(true), flex: 1 } }, React.createElement(IconText, { icon: 'arrowRight', size: 16, after: true }, labels[step + 1])));
}

// ---------- Host: the section rendered inside the event form ----------
// The quiz belongs to a saved event, so a brand-new form just says to save the draft first. Settings
// (source book, time limit) are editable while the event is a draft; questions until it is with
// Inkroot / open. Suggestions from guild members wait here for the host's approve / reject.
// Pool size the server asks for before a quiz can open (guild_quiz_min_questions(), migration 182). Only draws a
// progress bar; the server still enforces it and its own message wins.
const QUIZ_POOL_MIN = 15;
const TIME_CHIPS = [5, 10, 15, 20];

export function QuizHostSection({ guildId, members, event }) {
    const eventId = event && event.id;
    const approvalStatus = event && event.approval_status;
    const settingsEditable = ['draft', 'rejected'].includes(approvalStatus);
    const questionsEditable = ['draft', 'rejected', 'approved', 'published'].includes(approvalStatus);

    const [source, setSource] = useState(event && event.quizSource ? event.quizSource : 'anthology');
    const [book, setBook] = useState(event && event.quizAnthologyId ? { id: event.quizAnthologyId, title: 'Chosen anthology' } : null);
    const [minutes, setMinutes] = useState(event && event.quizTimeLimitSeconds ? String(event.quizTimeLimitSeconds / 60) : '10');
    const [settingsMsg, setSettingsMsg] = useState(null);
    const [questions, setQuestions] = useState(undefined);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [step, setStep] = useState(0); // 0 Settings, 1 Questions

    const reload = () => { if (eventId) fetchGuildQuizQuestionsForHost(eventId).then(setQuestions); };
    useEffect(reload, [eventId]);

    if (!eventId) {
        return React.createElement("div", { style: qzCardStyle },
            React.createElement("div", { style: { ...qzLabelStyle, marginBottom: 6 } }, 'Quiz for this event'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textDim } },
                'Save the event as a draft first \u2014 then reopen it to choose the book, set the time limit and add questions.'));
    }

    const nameOf = (id) => { const m = (members || []).find((x) => x.user_id === id); return m ? (m.name || null) : null; };
    const guard = async (fn) => {
        setBusy(true);
        setError(null);
        try { await fn(); reload(); } catch (e) { setError(e.message || 'Something went wrong.'); } finally { setBusy(false); }
    };

    const saveSettings = () => guard(async () => {
        setSettingsMsg(null);
        if (source === 'anthology' && !book) throw new Error('Choose the source book first.');
        await setGuildQuizSettings(eventId, { source, anthologyId: book && book.id, timeLimitSeconds: Math.round(Number(minutes) * 60) });
        setSettingsMsg('Saved.');
    });

    const approved = (questions || []).filter((q) => q.status === 'approved');
    const pending = (questions || []).filter((q) => q.status === 'pending');
    const bookOk = source !== 'anthology' || !!book;
    const checklistItems = [
        source === 'anthology' ? { ok: !!book, label: 'Source book chosen' } : { ok: true, label: 'Trivia \u2014 no book needed' },
        { ok: Number(minutes) > 0, label: 'Time limit set' },
        { ok: approved.length >= QUIZ_POOL_MIN, label: `${approved.length} of ${QUIZ_POOL_MIN} approved questions` },
        ...(pending.length ? [{ ok: false, label: `${pending.length} awaiting your review` }] : []),
    ];
    const STEPS = [{ label: 'Settings', done: bookOk && Number(minutes) > 0 }, { label: 'Questions', done: approved.length >= QUIZ_POOL_MIN }];
    const STEP_LABELS = STEPS.map((x) => x.label);

    return React.createElement("div", { className: "ik-ev", style: qzCardStyle },
        React.createElement(HostStepper, { steps: STEPS, step, onStep: setStep, ready: checklistItems.filter((x) => x.ok).length, total: questions !== undefined ? checklistItems.length : 0 }),
        React.createElement("div", { style: { ...qzLabelStyle, marginBottom: 6 } }, 'Quiz for this event'),
        React.createElement(QuizHowItWorks, { title: 'How this quiz works' },
            'Entrants get one attempt with one overall time limit. Score is correct answers; ties go to the fastest. Questions lock when the event opens.'),
        questions !== undefined && step === 0 && React.createElement(QuizSetupChecklist, { items: checklistItems }),
        error && React.createElement("div", { style: S.errorText }, error),
        React.createElement("div", { style: S.col10 },
            step === 0 && React.createElement(React.Fragment, null,
            React.createElement("div", null,
                React.createElement("label", { style: qzLabelStyle }, 'Source'),
                React.createElement(Segmented, { label: 'Source', value: source, disabled: !settingsEditable, onChange: (v) => { setSource(v); setBook(null); },
                    options: Object.entries(SOURCE_POOLS).map(([v, label]) => ({ value: v, label })) })),
            source === 'anthology' && settingsEditable && React.createElement("div", null,
                React.createElement("label", { style: qzLabelStyle }, book ? `Book \u2014 ${book.title}` : 'Choose the book'),
                React.createElement(BookPicker, { pool: source, guildId, members, value: book, onPick: setBook })),
            React.createElement("div", null,
                React.createElement("label", { style: qzLabelStyle }, 'Time limit (minutes)'),
                React.createElement(Segmented, { label: 'Time limit', value: Number(minutes), disabled: !settingsEditable, onChange: (m) => setMinutes(String(m)),
                    options: TIME_CHIPS.map((m) => ({ value: m, label: `${m} min` })) }),
                React.createElement("input", { type: 'number', min: 0.5, step: 0.5, value: minutes, disabled: !settingsEditable, onChange: (e) => setMinutes(e.target.value), "aria-label": 'Custom time limit in minutes', placeholder: 'Or type a custom number of minutes', style: { ...evInputStyle, marginTop: 8 } })),
            settingsEditable && React.createElement("div", { style: S.rowCenter8 },
                React.createElement("button", { disabled: busy, onClick: saveSettings, style: { ...qzBtnStyle(true), opacity: busy ? 0.5 : 1 } }, 'Save quiz settings'),
                settingsMsg && React.createElement("span", { style: S.successText }, settingsMsg)),
            !settingsEditable && React.createElement("div", { style: S.noteSmall }, 'Settings can only be changed while the event is a draft.')),

            step === 1 && React.createElement(React.Fragment, null,
            React.createElement("div", null,
                React.createElement("label", { style: qzLabelStyle }, questions === undefined ? 'Questions' : `Questions \u2014 ${approved.length} approved${pending.length ? `, ${pending.length} awaiting review` : ''}`),
                questions !== undefined && React.createElement("div", { style: { margin: '2px 0 10px' } },
                    React.createElement(HostProgress, { value: approved.length, max: QUIZ_POOL_MIN, label: 'Approved questions needed to open' })),
                React.createElement("div", { style: S.col8 },
                    questions === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
                    pending.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: nameOf(q.authorId) },
                        questionsEditable && React.createElement("div", { style: S.row8 },
                            React.createElement("button", { disabled: busy, onClick: () => guard(() => reviewGuildQuizQuestion(q.id, true)), style: qzBtnStyle(true) }, 'Approve'),
                            React.createElement(ConfirmButton, { label: 'Reject', confirmLabel: 'Yes, reject', disabled: busy, onConfirm: () => guard(() => reviewGuildQuizQuestion(q.id, false)), buttonStyle: qzBtnStyle(false) })))),
                    approved.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: q.origin === 'member' ? nameOf(q.authorId) : null },
                        questionsEditable && React.createElement(ConfirmButton, { label: 'Remove', confirmLabel: 'Yes, remove', disabled: busy, onConfirm: () => guard(() => removeGuildQuizQuestion(q.id)), buttonStyle: { background: 'none', border: 'none', color: C.danger, fontSize: TYPE_SCALE[13], cursor: 'pointer', padding: '0 4px', minHeight: 44, alignSelf: 'flex-start' } }))),
                    questions && questions.length === 0 && React.createElement("div", { style: S.noteItalic }, 'No questions yet.'))),
            questionsEditable && React.createElement("div", null,
                React.createElement("label", { style: qzLabelStyle }, 'Add a question'),
                React.createElement(QuizQuestionForm, {
                    busy, submitLabel: 'Add question',
                    onSubmit: async (q) => { await hostAddGuildQuizQuestion(eventId, { text: q.text, options: q.options, correctOptionId: q.correctOptionId }); reload(); },
                }))),
            React.createElement(HostStepNav, { step, last: 1, labels: STEP_LABELS, onStep: setStep })));
}

// ---------- Member: suggest a question for the hosting guild's quiz ----------
// Rendered by EventCard for members of the hosting guild while questions can still change. The
// host reviews each one; a question you wrote bars you from entering this quiz (server rule), which
// is said up front so nobody finds out after paying.
export function QuizSuggestPanel({ event, noun = 'quiz' }) {
    const [mine, setMine] = useState(undefined);
    const [busy, setBusy] = useState(false);
    const reload = () => fetchMyGuildQuizSuggestions(event.id).then(setMine);
    useEffect(() => { reload(); }, [event.id]);

    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textSoft, marginBottom: 6 } }, 'Suggest a question'),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textDim, marginBottom: 8 } },
            `Write a multiple-choice question for this ${noun} \u2014 the host decides whether it goes in. Members of the hosting guild can\u2019t enter the ${noun}.`),
        (mine || []).length > 0 && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6], marginBottom: 8 } },
            mine.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q }))),
        React.createElement(QuizQuestionForm, {
            busy, submitLabel: 'Suggest question',
            onSubmit: async (q) => {
                setBusy(true);
                try { await suggestGuildQuizQuestion(event.id, { text: q.text, options: q.options, correctOptionId: q.correctOptionId }); await reload(); }
                finally { setBusy(false); }
            },
        }));
}

// ---------- Entrant panel: start, take and see the score of the one attempt ----------
export function GuildEventQuizPanel({ event, myUserId, hasPaidEntry }) {
    const [attempt, setAttempt] = useState(undefined);
    const [myResult, setMyResult] = useState(undefined);
    const [session, setSession] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // Answers that could not be submitted (network drop, server hiccup): kept so the reader can retry instead of
    // losing every answer, which is what happened when the player was torn down in `finally`.
    const [unsent, setUnsent] = useState(null);
    // A first start asks "Ready?" before the server clock begins; resuming an attempt already running does not.
    const [confirming, setConfirming] = useState(false);
    const saveKey = 'inkroot:quiz-progress:' + event.id;

    const load = () => {
        fetchMyGuildQuizAttempt(event.id).then(setAttempt);
        fetchMyGuildEventResult(event.id).then(setMyResult);
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const limit = event.quizTimeLimitSeconds;

    const handleStart = async () => {
        setConfirming(false);
        setBusy(true);
        setError(null);
        try {
            const s = await startGuildQuizAttempt(event.id);
            if (!s.questions.length) throw new Error('This quiz has no questions.');
            setSession({ questions: s.questions, deadlineMs: Date.now() + s.remainingSeconds * 1000 });
        } catch (e) {
            setError(e.message || 'Could not start the quiz.');
            load();
        } finally {
            setBusy(false);
        }
    };

    const handleFinish = async ({ answers }) => {
        setBusy(true);
        setError(null);
        try {
            // Answers only \u2014 the server grades them and measures the time itself.
            await submitGuildQuizAttempt(event.id, answers);
            setUnsent(null);
            clearSavedQuiz(saveKey);
        } catch (e) {
            setUnsent(answers);
            setError((e.message || 'Could not submit your answers.') + ' Your answers are saved on this screen \u2014 tap Retry submit while the clock is still running.');
        } finally {
            setSession(null);
            setBusy(false);
            load();
        }
    };

    const submitted = attempt && attempt.submitted;
    const closeDate = formatEventDate(event.end_date);
    const goldCard = { ...qzCardStyle, padding: 14, borderColor: goldA(0.4), background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` };
    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your quiz'),
        error && React.createElement("div", { style: S.errorText }, error),
        attempt === undefined && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textMuted } }, 'Loading\u2026'),
        submitted && React.createElement("div", { style: { ...qzCardStyle, padding: 14, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[16], marginBottom: 10 } },
            React.createElement(QuizScoreRing, { score: attempt.score, total: attempt.total }),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                React.createElement("div", { style: { ...qzPill(C.success), marginBottom: 6 } }, React.createElement(IconText, { icon: 'check', size: 12, strokeWidth: 2.6, gap: 4 }, 'Submitted')),
                React.createElement("div", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[15], color: C.textStrong } }, `${attempt.score} of ${attempt.total} correct`),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginTop: 2 } }, `in ${formatSeconds(attempt.elapsedMs || 0)} \u00b7 one attempt per entrant`),
                approvalStatus !== 'completed' && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textMuted, marginTop: 6, lineHeight: 1.45 } },
                    closeDate ? `Results are worked out after entries close on ${closeDate}.` : 'Results are worked out after entries close.'))),
        submitted && approvalStatus === 'completed' && myResult && myResult.place != null
            && React.createElement("div", { style: { ...goldCard, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], marginBottom: 10 } },
                React.createElement(InkIcon, { name: 'trophy', size: 24, color: C.goldBright }),
                React.createElement("div", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[15], lineHeight: 1.35, color: C.goldBright } },
                    `You placed ${ordinal(myResult.place)}${myResult.amountNaira ? ` \u2014 ${formatNaira(myResult.amountNaira)} is in your balance` : ''}`)),
        submitted && approvalStatus === 'completed' && myResult && myResult.place == null
            && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginBottom: 8 } }, 'The results are in \u2014 not this time.'),
        submitted && approvalStatus === 'completed' && !myResult
            && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginBottom: 8 } }, 'Waiting for the results.'),

        !submitted && attempt !== undefined && !session && approvalStatus === 'active' && React.createElement("div", { style: { ...qzCardStyle, padding: 14 } },
            attempt
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textDim, marginBottom: 12, lineHeight: 1.5 } }, 'You\u2019ve already started \u2014 pick up where the clock is.')
                : React.createElement("div", null,
                    event.quizSource === 'anthology' && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textDim, marginBottom: 10 } }, 'Read the book first.'),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 10 } },
                        React.createElement(QuizStatChip, { label: 'Time', value: limit ? formatLimit(limit) : 'Fixed' }),
                        React.createElement(QuizStatChip, { label: 'Attempts', value: '1' }),
                        React.createElement(QuizStatChip, { label: 'Go back', value: 'No' })),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginBottom: 12, lineHeight: 1.5 } }, 'The clock starts when you tap Start.')),
            confirming && !attempt
                ? React.createElement("div", { role: "alertdialog", "aria-label": "Ready to start?", style: { padding: 12, borderRadius: RADIUS_SCALE[12], background: C.surfaceMuted, border: `1px solid ${C.borderStrong}` } },
                    React.createElement("div", { style: { fontFamily: qzSerif, fontSize: TYPE_SCALE[15], color: C.textStrong, marginBottom: 4 } }, 'Ready?'),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, lineHeight: 1.5, marginBottom: 10 } }, `Your ${limit ? formatLimit(limit) : 'time'} begins the moment you tap Begin. Answers are final once you continue.`),
                    React.createElement("div", { style: S.row8 },
                        React.createElement("button", { disabled: busy, onClick: handleStart, style: { ...qzBtnStyle(true), flex: 1, minHeight: 52, borderRadius: RADIUS_SCALE[12], opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Begin'),
                        React.createElement("button", { disabled: busy, onClick: () => setConfirming(false), style: { ...qzBtnStyle(false), minHeight: 52, borderRadius: RADIUS_SCALE[12] } }, 'Not yet')))
                : React.createElement("button", { disabled: busy, onClick: attempt ? handleStart : () => setConfirming(true), style: { ...evBtnStyle(true), minHeight: 52, width: '100%', fontSize: TYPE_SCALE[13], borderRadius: RADIUS_SCALE[12], opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : (attempt ? 'Resume quiz' : 'Start quiz'))),
        !submitted && !session && unsent && React.createElement(QuizRetryBanner, { busy, onRetry: () => handleFinish({ answers: unsent }) }),
        !submitted && session && React.createElement(QuizPlayer, { questions: session.questions, deadlineMs: session.deadlineMs, onFinish: handleFinish, busy, saveKey }),
        !submitted && attempt !== undefined && !session && approvalStatus === 'completed'
            && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft } }, 'Entries closed before you finished.'));
}
