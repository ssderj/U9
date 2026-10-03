import { S, SERIF, pillStyle } from './guild-styles.js';
import { C, goldA, successA, infoA, urgencyColor } from './guild-theme.js';
import React, { useEffect, useRef, useState } from 'react';
import {
    attachGuildQuizQuestions, detachGuildQuizQuestion, fetchFlaggedTournamentAttempts, fetchGuildBankQuestions,
    fetchGuildQuizQuestionsForHost, fetchGuildTournamentSettings, fetchMyTournamentState, hostAddGuildQuizQuestion,
    reviewGuildQuizQuestion, setGuildTournamentSettings, startTournamentMatch, submitTournamentMatch,
} from '../lib/guild-events.js';
import {
    QuizPlayer, clearSavedQuiz, BookPicker, QuizQuestionForm, QuizQuestionRow, SOURCE_POOLS,
    QuizRetryBanner, QuizSetupChecklist, QuizHowItWorks, qzBtnStyle,
    Segmented, HostProgress, HostStepper, HostStepNav, IconText, ConfirmButton,
} from './guild-event-quiz-panel.jsx';
import { evBtnStyle, evInputStyle, formatEventDate } from './guild-event-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { Fold } from '../shared-ui/ui-primitives.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// ---------------------------------------------------------------------------------------------
// Tournament (READING brackets only; writing brackets are out of scope). The backend
// shipped in 176_migration_tournament_backend.sql and is live. What the
// server does, so nothing below ever has to (and nothing below is a security boundary):
//   1. Settings: set_guild_tournament_settings() saves rounds (4-6, the bracket's CEILING) and the
//      question source while the event is a draft; both lock when it opens. The player limit defaults to
//      2^rounds and can only be lowered (the event form's own limit field).
//   2. Closing entries (close_guild_event, or the end date) LOCKS the bracket: the entrants are shuffled
//      on the server, the bracket is the smallest full size that fits them (11 entrants -> 16 slots, so
//      4 rounds even if the host chose 6), and the empty slots are byes handed to random first-round
//      matches. The bracket shown to the host in the designer below is a PREVIEW only.
//   3. One round per day. A scheduled job decides each match at its deadline: both played -> most correct
//      wins, faster time breaks a tie, a tie on both is a server-side random decider; one played -> that
//      player advances; neither -> both are out and the next opponent gets a free pass.
//   4. A match: the same random subset of the event's question pool for both opponents, served WITHOUT
//      answer keys, options shuffled per player, graded and timed by the server, one attempt. The tab-switch
//      count is stored for the host and Inkroot only (TournamentReviewPanel) - never a disqualification,
//      and never shown to the players.
//   5. Prizes: 1st champion, 2nd losing finalist, 3rd the semifinal loser with more correct answers - only
//      players who actually played that match. Placements go through the existing compute -> escrow payout
//      (ComputedResultsControls); the host or Inkroot presses it once the final is decided.
//
// DECIDED: an entrant who wrote a question in the pool can't enter (the server's fairness rule, 174), and
// fewer than 2 paid entrants can't start a bracket (the host is told to wait). Still open: whether a random
// subset + shuffled options is enough to stop answer leaking between matches in the same round.
// event.tournament is no longer expected on the event row: the entrant panel reads its own state from
// fetchMyTournamentState() (get_my_tournament_state), whose shape is:
//   { kind: 'reading', status: 'entries_open'|'running'|'finished'|'no_contest', rounds, bracketRounds,
//     bracketSize, entriesClosed, currentRound, roundDeadlines: [iso per round],
//     bracket: [ [ { id, a, b, winnerId } ... ] per round ]   // a/b: {userId,name} | {bye:true} | null (TBD)
//     myMatch: { id, round, status: 'awaiting'|'submitted'|'won'|'lost'|'bye', opponent: {name}|null,
//                deadline, started, total?, myScore?, opponentScore?, decidedBy? } | null,
//     podium: { first, second, third } | null }
// ---------------------------------------------------------------------------------------------
const ROUND_OPTIONS = [4, 5, 6];

// Shared fragments live in guild-styles.js; these names are kept so every use below reads the same.
const tnLabelStyle = S.capsLabel;
const tnCardStyle = S.card;

// UI-only helpers. Nothing here changes how a bracket is built, played or decided - that is the server's job.
const tnSerif = SERIF;
const tnPill = (color) => pillStyle(color, 10);

// One card for every "where do I stand" state: a tinted icon, a headline and an optional line below. The tone
// carries the mood - being knocked out is a quiet neutral card, not an alarm.
function StatusCard({ tone = 'neutral', icon, title, sub, children }) {
    const tones = {
        success: { c: C.success, border: `${C.success}55`, bg: successA(0.07) },
        info: { c: C.info, border: `${C.info}55`, bg: infoA(0.07) },
        out: { c: C.textBright, border: C.borderStrong, bg: C.surfaceMuted },
        neutral: { c: C.neutralSoft, border: C.border, bg: C.panel },
    };
    const t = tones[tone] || tones.neutral;
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], padding: '14px 14px', borderRadius: RADIUS_SCALE[12], background: t.bg, border: `1px solid ${t.border}` } },
        icon && React.createElement(InkIcon, { name: icon, size: 24, color: t.c }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontFamily: tnSerif, fontSize: TYPE_SCALE[15], lineHeight: 1.3, color: t.c } }, title),
            sub && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginTop: 3, lineHeight: 1.45 } }, sub),
            children));
}

// "7 \u2013 5": the two scores side by side. Same numbers the old one-line subtitle printed.
function ScoreLine({ mine, theirs, decidedBy }) {
    return React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', gap: SPACE_SCALE[8], marginTop: 6 } },
        React.createElement("span", { style: { fontFamily: tnSerif, fontSize: TYPE_SCALE[20], color: C.textStrong } }, `${mine} \u2013 ${theirs}`),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft } }, decidedBy ? `decided by ${DECIDED_BY_TEXT[decidedBy] || decidedBy}` : 'you \u2013 opponent'));
}

function roundLabel(round, total) {
    const fromEnd = total - round;
    if (fromEnd === 0) return 'Final';
    if (fromEnd === 1) return 'Semifinal';
    if (fromEnd === 2) return 'Quarterfinal';
    return `Round ${round}`;
}

// ---------- Preview bracket (host designer only) ----------
// The bracket shrinks to the smallest full size that fits the entrants (capped at 2^rounds), so a
// bye never faces another bye. Byes go to randomly chosen first-round matches, i.e. random players.
function buildPreviewBracket(entrantCount, rounds) {
    const n = Math.max(2, Math.min(entrantCount, 2 ** rounds));
    let size = 2;
    while (size < n) size *= 2;
    const totalRounds = Math.round(Math.log2(size));
    const names = Array.from({ length: n }, (_, i) => ({ userId: `p${i + 1}`, name: `Entrant ${i + 1}` }));
    for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
    }
    const matchCount = size / 2;
    const byes = size - n; // always < matchCount, so at most one bye per match
    const order = Array.from({ length: matchCount }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
    }
    const byeMatches = new Set(order.slice(0, byes));
    let next = 0;
    const round1 = [];
    for (let m = 0; m < matchCount; m++) {
        const a = names[next++];
        const b = byeMatches.has(m) ? { bye: true } : names[next++];
        round1.push({ id: `r1m${m}`, a, b, winnerId: b.bye ? a.userId : null });
    }
    const bracket = [round1];
    for (let r = 2; r <= totalRounds; r++) {
        const prev = bracket[r - 2];
        const round = [];
        for (let m = 0; m < prev.length; m += 2) {
            const carry = (match) => {
                if (!match.winnerId) return null;
                return match.a && match.a.userId === match.winnerId ? match.a : match.b;
            };
            round.push({ id: `r${r}m${m / 2}`, a: carry(prev[m]), b: carry(prev[m + 1]), winnerId: null });
        }
        bracket.push(round);
    }
    return { bracket, size, byes, entrants: n };
}

// ---------- Countdown to a round deadline ----------
// Display only. More than an hour out it reads "Xh Ym" and refreshes every 30s; inside the last hour it
// switches to a ticking mm:ss so the urgency is real. The server decides the round at the deadline either way.
function RoundCountdown({ deadline }) {
    const [now, setNow] = useState(Date.now());
    const msLeft = deadline ? new Date(deadline).getTime() - now : NaN;
    const live = msLeft > 0 && msLeft < 3600000;
    useEffect(() => {
        setNow(Date.now());
        const t = setInterval(() => setNow(Date.now()), live ? 1000 : 30000);
        return () => clearInterval(t);
    }, [live]);
    if (!deadline) return null;
    const ms = msLeft;
    if (Number.isNaN(ms)) return null;
    if (ms <= 0) return React.createElement("span", { style: { color: C.danger } }, 'Deadline passed');
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    const text = live ? `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')} left` : `${h}h ${m}m left`;
    return React.createElement("span", { style: { color: urgencyColor(ms / 1000, { copper: 6 * 3600, danger: 3600 }), fontVariantNumeric: 'tabular-nums' } }, text);
}

// ---------- Bracket: rounds as columns, side-scrolling on a phone ----------
// Presentation only. Your own matches are outlined in gold, the live round's heading is lit, and real elbow
// connectors join each pair of matches to the match they feed. Above the columns a "Your path" strip shows
// where you stand round by round; tapping a step scrolls the bracket to that round. Nothing here reads or
// changes anything beyond the bracket data the server already sends.
const BRACKET_GAP = SPACE_SCALE[14]; // space between round columns; the connectors are drawn inside it

// One elbow: two stubs leave the pair of feeder matches, meet in a vertical line, and one stub enters the next match.
// The pair sits at 25% / 75% of its own box and the match it feeds sits at 50% of it, so percentages line up.
function BracketConnector({ lit }) {
    const line = lit ? goldA(0.7) : C.borderStrong;
    const half = Math.round(BRACKET_GAP / 2);
    const bit = (extra) => React.createElement("span", { "aria-hidden": "true", style: { position: 'absolute', background: line, ...extra } });
    return React.createElement("div", { "aria-hidden": "true", style: { position: 'absolute', top: 0, bottom: 0, right: -BRACKET_GAP, width: BRACKET_GAP, pointerEvents: 'none' } },
        bit({ top: '25%', left: 0, width: half, height: 1 }),
        bit({ top: '75%', left: 0, width: half, height: 1 }),
        bit({ top: '25%', bottom: '25%', left: half, width: 1 }),
        bit({ top: '50%', left: half, width: BRACKET_GAP - half, height: 1 }));
}

// Where I stand in each round, derived from the bracket alone: won / out / next (undecided) / not reached.
function myPathSteps(bracket, myUserId) {
    const isMe = (x) => x && !x.bye && x.userId === myUserId;
    let out = false;
    return bracket.map((round, ri) => {
        const m = round.find((x) => isMe(x.a) || isMe(x.b));
        if (!m) return { ri, state: out ? 'out' : 'ahead' };
        if (m.winnerId == null) return { ri, state: 'next' };
        if (m.winnerId === myUserId) return { ri, state: 'won', bye: !!((m.a && m.a.bye) || (m.b && m.b.bye)) };
        out = true;
        return { ri, state: 'lost' };
    });
}

function BracketView({ bracket, myUserId, currentRound }) {
    const total = bracket.length;
    const scrollRef = useRef(null);
    const colRefs = useRef([]);
    const involvesMe = (m) => myUserId != null && [m.a, m.b].some((x) => x && !x.bye && x.userId === myUserId);
    const jumpTo = (ri, smooth) => {
        const box = scrollRef.current;
        const col = colRefs.current[ri];
        if (!box || !col) return;
        const reduce = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const left = Math.max(0, col.offsetLeft - 12);
        if (smooth && !reduce && box.scrollTo) box.scrollTo({ left, behavior: 'smooth' });
        else box.scrollLeft = left;
    };
    useEffect(() => {
        let target = currentRound ? currentRound - 1 : -1;
        if (target < 0) { bracket.forEach((round, ri) => { if (round.some(involvesMe)) target = ri; }); }
        if (target >= 0) jumpTo(target, false);
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [total, currentRound]);

    const sideRow = (side, isWinner, otherWon) => {
        const label = side == null ? 'TBD' : side.bye ? 'Bye' : side.name || 'Unnamed';
        const mine = side && !side.bye && myUserId != null && side.userId === myUserId;
        return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], padding: '7px 10px', fontSize: TYPE_SCALE[13],
            color: side == null || side.bye ? C.neutral : (mine ? C.goldBright : C.text),
            fontStyle: side == null || side.bye ? 'italic' : 'normal',
            fontWeight: isWinner ? 600 : 400, opacity: otherWon ? 0.5 : 1,
            textDecoration: otherWon && side && !side.bye ? 'line-through' : 'none', textDecorationColor: C.neutralDim,
            background: isWinner ? successA(0.10) : 'transparent',
        } },
            React.createElement("span", { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, mine ? `${label} (you)` : label),
            isWinner && React.createElement("span", { role: "img", "aria-label": "winner", style: { display: 'inline-flex', color: C.success } }, React.createElement(InkIcon, { name: 'check', size: 14, strokeWidth: 2.6 })));
    };

    const matchCard = (m, ri) => React.createElement("div", { key: m.id, style: { padding: `${SPACE_SCALE[4]}px 0`, position: 'relative' } },
        // Stub from the card's right edge into the connector (only when the elbow is drawn by the pair box).
        React.createElement("div", { style: { ...tnCardStyle, position: 'relative', padding: 0, borderRadius: RADIUS_SCALE[12], border: `1px solid ${involvesMe(m) ? goldA(0.55) : C.border}`, background: involvesMe(m) ? C.surfaceWarm : C.panel } },
            ri > 0 && React.createElement("span", { "aria-hidden": "true", style: { position: 'absolute', top: '50%', left: -BRACKET_GAP / 2, width: BRACKET_GAP / 2, height: 1, background: C.borderStrong } }),
            React.createElement("div", { style: { borderRadius: RADIUS_SCALE[12], overflow: 'hidden' } },
                sideRow(m.a, m.winnerId && m.a && m.a.userId === m.winnerId, m.winnerId && m.a && m.a.userId !== m.winnerId),
                React.createElement("div", { style: { height: 1, background: C.border } }),
                sideRow(m.b, m.winnerId && m.b && m.b.userId === m.winnerId, m.winnerId && m.b && m.b.userId !== m.winnerId))));

    // Matches are grouped in the pairs that feed one match in the next round, so each pair can own its elbow.
    const columnBody = (round, ri) => {
        if (ri >= total - 1) {
            return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', justifyContent: 'center', flex: 1 } }, round.map((m) => matchCard(m, ri)));
        }
        const groups = [];
        for (let i = 0; i < round.length; i += 2) groups.push(round.slice(i, i + 2));
        return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', flex: 1 } },
            groups.map((g, gi) => React.createElement("div", { key: gi, style: { position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-around' } },
                g.map((m) => matchCard(m, ri)),
                g.length === 2 && React.createElement(BracketConnector, { lit: g.some(involvesMe) }))));
    };

    // "Your path" - only for a real player in a real bracket (not the host's preview).
    const steps = myUserId != null && bracket.some((r) => r.some(involvesMe)) ? myPathSteps(bracket, myUserId) : null;
    const stepLook = (st) => st === 'won' ? { c: C.success, icon: 'check' }
        : st === 'next' ? { c: C.goldBright, icon: 'dot' }
            : st === 'lost' ? { c: C.textBright, icon: 'close' }
                : { c: C.neutralMid, icon: 'minus' };
    const pathNode = steps && React.createElement("nav", { "aria-label": "Your path through the bracket", style: { marginBottom: 10 } },
        React.createElement("div", { style: { ...tnLabelStyle, marginBottom: 6 } }, 'Your path'),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], overflowX: 'auto', paddingBottom: 2 } },
            steps.map((s, i) => {
                const look = stepLook(s.state);
                const text = s.state === 'won' && s.bye ? 'Free pass' : s.state === 'next' ? 'Next' : s.state === 'won' ? 'Won' : s.state === 'lost' ? 'Out' : null;
                return React.createElement(React.Fragment, { key: s.ri },
                    i > 0 && React.createElement("span", { "aria-hidden": "true", style: { flexShrink: 0, width: 10, height: 1, background: steps[i - 1].state === 'won' ? C.success : C.borderStrong } }),
                    React.createElement("button", { type: "button", onClick: () => jumpTo(s.ri, true), "aria-label": `${roundLabel(s.ri + 1, total)}${text ? `: ${text}` : ''}`,
                        style: { flexShrink: 0, minHeight: 44, display: 'inline-flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, padding: '4px 12px', borderRadius: RADIUS_SCALE[12], cursor: 'pointer',
                            color: look.c, background: s.state === 'next' ? goldA(0.10) : 'transparent', border: `1px solid ${s.state === 'ahead' || s.state === 'out' ? C.border : `${look.c}66`}`, opacity: s.state === 'out' ? 0.6 : 1 } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, whiteSpace: 'nowrap' } }, React.createElement(IconText, { icon: look.icon, size: 12, strokeWidth: 2.6, gap: 5 }, roundLabel(s.ri + 1, total))),
                        text && React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft } }, text)));
            })));

    return React.createElement("div", null,
        pathNode,
        React.createElement("div", { ref: scrollRef, style: { overflowX: 'auto', paddingBottom: 8, scrollSnapType: 'x proximity' } },
            React.createElement("div", { style: { display: 'flex', gap: BRACKET_GAP, minWidth: 'max-content' } },
                bracket.map((round, ri) => {
                    const live = currentRound === ri + 1;
                    return React.createElement("div", { key: ri, ref: (el) => { colRefs.current[ri] = el; }, style: { display: 'flex', flexDirection: 'column', width: 160, scrollSnapAlign: 'start' } },
                        React.createElement("div", { style: { ...tnLabelStyle, textAlign: 'center', marginBottom: 8, color: live ? C.goldBright : C.textSoft, fontWeight: live ? 700 : 400 } }, roundLabel(ri + 1, total), live ? ' \u00b7 live' : ''),
                        columnBody(round, ri));
                }))));
}

// ---------- Host setup constants ----------
// The pool size the server asks for before a tournament can open (guild_tournament_min_pool(), migration 176)
// Used only to draw a progress bar; the server still enforces it (and the pool's cap) and its message wins.
const POOL_MIN = 15;

// ---------- Host: settings, question pool and a designer preview, inside the event form ----------
// The tournament belongs to a saved event, so a brand-new form just says to save the draft first. Rounds and
// the source book are editable while the event is a draft; the pool (the same shared bank a quiz uses)
// until it is with Inkroot / open. Members' suggestions wait here for approve / reject, exactly as for a quiz.
export function TournamentHostSection({ guildId, members, event }) {
    const eventId = event && event.id;
    const approvalStatus = event && event.approval_status;
    const settingsEditable = ['draft', 'rejected'].includes(approvalStatus);
    const questionsEditable = ['draft', 'rejected', 'approved', 'published'].includes(approvalStatus);

    const [saved, setSaved] = useState(undefined);
    const [rounds, setRounds] = useState(4);
    const [source, setSource] = useState('anthology');
    const [book, setBook] = useState(null);
    const [settingsMsg, setSettingsMsg] = useState(null);
    const [questions, setQuestions] = useState(undefined);
    const [bank, setBank] = useState([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [designerOpen, setDesignerOpen] = useState(false);
    const [count, setCount] = useState('12');
    const [preview, setPreview] = useState(null);
    const [step, setStep] = useState(0); // 0 Settings, 1 Questions, 2 Preview

    const reloadSettings = () => {
        if (!eventId) return;
        fetchGuildTournamentSettings(eventId).then((s) => {
            setSaved(s);
            if (s) {
                setRounds(s.rounds);
                setSource(s.source);
                setBook(s.anthologyId ? { id: s.anthologyId, title: 'Chosen anthology' } : null);
            }
        });
    };
    const reloadQuestions = (savedSettings) => {
        if (!eventId) return;
        fetchGuildQuizQuestionsForHost(eventId).then(setQuestions);
        const cfg = savedSettings === undefined ? saved : savedSettings;
        if (cfg && guildId) {
            fetchGuildBankQuestions(guildId, { anthologyId: cfg.anthologyId, generalOnly: cfg.source === 'none' }).then(setBank);
        }
    };
    useEffect(() => { reloadSettings(); }, [eventId]);
    useEffect(() => { reloadQuestions(); }, [eventId, saved && saved.source, saved && saved.anthologyId]);

    if (!eventId) {
        return React.createElement("div", { style: tnCardStyle },
            React.createElement("div", { style: { ...tnLabelStyle, marginBottom: 6 } }, 'Reading tournament'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textDim } },
                'Save the event as a draft first \u2014 then reopen it to choose the rounds and the book and to add questions.'));
    }

    const nameOf = (id) => { const m = (members || []).find((x) => x.user_id === id); return m ? (m.name || null) : null; };
    const guard = async (fn) => {
        setBusy(true);
        setError(null);
        try { await fn(); reloadQuestions(); } catch (e) { setError(e.message || 'Something went wrong.'); } finally { setBusy(false); }
    };

    const saveSettings = () => guard(async () => {
        setSettingsMsg(null);
        if (source === 'anthology' && !book) throw new Error('Choose the source book first.');
        await setGuildTournamentSettings(eventId, { rounds, source, anthologyId: book && book.id });
        setSettingsMsg('Saved.');
        reloadSettings();
    });

    const pool = (questions || []).filter((q) => q.inPool && q.status === 'approved');
    const pending = (questions || []).filter((q) => q.status === 'pending');
    const poolIds = new Set(pool.map((q) => q.id));
    const bankExtras = (bank || []).filter((q) => q.status === 'approved' && !poolIds.has(q.id));
    const size = 2 ** rounds;

    const generate = () => setPreview(buildPreviewBracket(Number(count) || 2, rounds));

    // Derived from state this section already holds. POOL_MIN only draws the progress bar; the server owns the real rule.
    const settingsDone = !!saved && (source !== 'anthology' || !!book || !!saved.anthologyId);
    const checklistItems = [
        { ok: !!saved, label: 'Tournament settings saved' },
        ...(source === 'anthology' ? [{ ok: !!book || !!(saved && saved.anthologyId), label: 'Source book chosen' }] : []),
        { ok: pool.length >= POOL_MIN, label: `${pool.length} of ${POOL_MIN} approved questions in the pool` },
        ...(pending.length ? [{ ok: false, label: `${pending.length} awaiting your review` }] : []),
    ];
    const STEPS = [{ label: 'Settings', done: settingsDone }, { label: 'Questions', done: pool.length >= POOL_MIN }, { label: 'Preview', done: false }];
    const STEP_LABELS = STEPS.map((x) => x.label);

    return React.createElement("div", { className: "ik-ev", style: tnCardStyle },
        React.createElement(HostStepper, { steps: STEPS, step, onStep: setStep, ready: checklistItems.filter((x) => x.ok).length, total: questions !== undefined ? checklistItems.length : 0 }),
        React.createElement("div", { style: { ...tnLabelStyle, marginBottom: 6 } }, 'Reading tournament'),
        React.createElement(QuizHowItWorks, { title: 'How this tournament works' },
            'Entries stay open until the cap is reached or you close them. Closing locks the bracket and starts round 1; one round per day. The bracket is built and run by the server \u2014 it needs at least 2 paid entrants.'),
        questions !== undefined && step === 0 && React.createElement(QuizSetupChecklist, { items: checklistItems }),
        error && React.createElement("div", { style: S.errorText }, error),
        React.createElement("div", { style: S.col10 },
            step === 0 && React.createElement(React.Fragment, null,
            React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, 'Rounds'),
                React.createElement(Segmented, { label: 'Rounds', value: rounds, disabled: !settingsEditable, onChange: (r) => { setRounds(r); setPreview(null); },
                    options: ROUND_OPTIONS.map((r) => ({ value: r, label: `${r} rounds`, sub: `up to ${2 ** r} players` })) }),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 4 } },
                    'The player limit defaults to the most a bracket this deep can hold; you can lower it above. With fewer players the bracket shrinks to fit.')),
            React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, 'Question source'),
                React.createElement(Segmented, { label: 'Question source', value: source, disabled: !settingsEditable, onChange: (v) => { setSource(v); setBook(null); },
                    options: Object.entries(SOURCE_POOLS).map(([v, label]) => ({ value: v, label })) })),
            source === 'anthology' && settingsEditable && React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, book ? `Book \u2014 ${book.title}` : 'Choose the book'),
                React.createElement(BookPicker, { pool: source, guildId, members, value: book, onPick: setBook })),
            settingsEditable && React.createElement("div", { style: S.rowCenter8 },
                React.createElement("button", { disabled: busy, onClick: saveSettings, style: { ...qzBtnStyle(true), opacity: busy ? 0.5 : 1 } }, 'Save tournament settings'),
                settingsMsg && React.createElement("span", { style: S.successText }, settingsMsg)),
            !settingsEditable && React.createElement("div", { style: S.noteSmall }, 'Settings can only be changed while the event is a draft.'),
            saved === null && settingsEditable && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.gold } },
                'Save these settings before opening the event \u2014 a tournament can\u2019t open without them.')),

            step === 1 && React.createElement(React.Fragment, null,
            React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, questions === undefined ? 'Question pool' : `Question pool \u2014 ${pool.length} approved${pending.length ? `, ${pending.length} awaiting review` : ''}`),
                saved && questions !== undefined && React.createElement("div", { style: { margin: '2px 0 10px' } },
                    React.createElement(HostProgress, { value: pool.length, max: POOL_MIN, label: 'Approved questions needed to open' })),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginBottom: 6 } },
                    'Each match draws 10 random questions from this pool, the same for both players. The pool needs at least 15 approved questions to open, holds up to 50, and locks when the event opens. Anyone who wrote one of these questions can\u2019t enter.'),
                saved === null && React.createElement("div", { style: S.noteItalic }, 'Save the settings above to start building the pool.'),
                saved && React.createElement("div", { style: S.col8 },
                    questions === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
                    pending.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: nameOf(q.authorId) },
                        questionsEditable && React.createElement("div", { style: S.row8 },
                            React.createElement("button", { disabled: busy, onClick: () => guard(() => reviewGuildQuizQuestion(q.id, true)), style: qzBtnStyle(true) }, 'Approve'),
                            React.createElement(ConfirmButton, { label: 'Reject', confirmLabel: 'Yes, reject', disabled: busy, onConfirm: () => guard(() => reviewGuildQuizQuestion(q.id, false)), buttonStyle: qzBtnStyle(false) })))),
                    pool.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: q.origin === 'member' ? nameOf(q.authorId) : null },
                        questionsEditable && React.createElement("button", { disabled: busy, onClick: () => guard(() => detachGuildQuizQuestion(eventId, q.id)), style: { background: 'none', border: 'none', color: C.danger, fontSize: TYPE_SCALE[13], cursor: 'pointer', padding: '0 4px', minHeight: 44, alignSelf: 'flex-start' } }, 'Take out of the pool'))),
                    questions && pool.length === 0 && pending.length === 0 && React.createElement("div", { style: S.noteItalic }, 'No questions in the pool yet.'))),

            saved && questionsEditable && bankExtras.length > 0 && React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, `Approved in the guild\u2019s bank \u2014 ${bankExtras.length} not in this pool`),
                React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8], maxHeight: 260, overflowY: 'auto' } },
                    bankExtras.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: q.origin === 'member' ? nameOf(q.authorId) : null },
                        React.createElement("button", { disabled: busy, onClick: () => guard(() => attachGuildQuizQuestions(eventId, [q.id])), style: { ...qzBtnStyle(false), alignSelf: 'flex-start' } }, 'Add to the pool'))))),

            saved && questionsEditable && React.createElement("div", null,
                React.createElement("label", { style: tnLabelStyle }, 'Add a question'),
                React.createElement(QuizQuestionForm, {
                    busy, submitLabel: 'Add question',
                    onSubmit: async (q) => { await hostAddGuildQuizQuestion(eventId, { text: q.text, options: q.options, correctOptionId: q.correctOptionId }); reloadQuestions(); },
                }))),

            // The designer is a PREVIEW of how a bracket of N players will look; nothing here is stored.
            step === 2 && (!designerOpen
                ? React.createElement("button", { onClick: () => setDesignerOpen(true), style: qzBtnStyle(false) }, 'Open bracket designer (preview)')
                : React.createElement("div", { style: S.col10 },
                    React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr', gap: SPACE_SCALE[8] } },
                        React.createElement("div", null,
                            React.createElement("label", { style: tnLabelStyle }, 'Sample players'),
                            React.createElement("input", { type: "number", min: "2", max: size, value: count, onChange: (e) => setCount(e.target.value), style: evInputStyle }))),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft } },
                        `Preview only \u2014 nothing here is stored. Fewer players than ${size}? The bracket shrinks to fit, and any empty spots become free passes (byes) given to random players.`),
                    React.createElement("div", { style: S.row8 },
                        React.createElement("button", { onClick: generate, style: qzBtnStyle(true) }, preview ? 'Reshuffle' : 'Preview bracket'),
                        React.createElement("button", { onClick: () => { setDesignerOpen(false); setPreview(null); }, style: qzBtnStyle(false) }, 'Close designer')),
                    preview && React.createElement("div", null,
                        React.createElement("div", { style: S.softHint },
                            `${preview.entrants} players in a ${preview.size}-slot bracket${preview.byes > 0 ? ` \u2014 ${preview.byes} free pass${preview.byes === 1 ? '' : 'es'} (random)` : ''}.`),
                        React.createElement(BracketView, { bracket: preview.bracket, myUserId: null })))),
            step === 2 && React.createElement(QuizHowItWorks, { title: 'How matches are decided' },
                'Both opponents get the same questions; most correct answers wins, speed breaks ties, and a dead heat is settled at random. Third place goes to the semifinal loser with more correct answers. If one opponent misses the deadline the other advances; if neither shows, both are out and their next opponent gets a free pass.'),
            React.createElement(HostStepNav, { step, last: 2, labels: STEP_LABELS, onStep: setStep })));
}

// ---------- Round schedule: when each round ends ----------
// Display only: the dates are the server's roundDeadlines (one per round) and nothing here decides a match.
function RoundTimeline({ deadlines, total, currentRound }) {
    const now = Date.now();
    const fmt = (iso) => {
        try { return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
        catch (e) { return ''; }
    };
    const rows = deadlines.map((iso, i) => ({ iso, i, ms: new Date(iso).getTime() })).filter((r) => !Number.isNaN(r.ms));
    if (rows.length === 0) return null;
    return React.createElement("div", { style: { ...tnCardStyle, padding: '10px 12px', marginBottom: 12, borderRadius: RADIUS_SCALE[12] } },
        React.createElement("div", { style: { ...tnLabelStyle, marginBottom: 6 } }, 'Schedule'),
        React.createElement("ol", { style: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
            rows.map((r) => {
                const past = r.ms <= now;
                const live = currentRound === r.i + 1 && !past;
                const color = live ? C.goldBright : past ? C.success : C.textSoft;
                return React.createElement("li", { key: r.i, "aria-current": live ? 'step' : undefined, style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[13], color, fontWeight: live ? 700 : 400 } },
                    React.createElement(IconText, { icon: past ? 'check' : live ? 'dot' : 'circle', size: 12, strokeWidth: 2.4, gap: 6 }, roundLabel(r.i + 1, total)),
                    React.createElement("span", { style: { color: past ? C.textMuted : C.textSoft, fontVariantNumeric: 'tabular-nums' } }, `${past ? 'Ended' : 'Ends'} ${fmt(r.iso)}`));
            })));
}

// ---------- Entrant panel ----------
// Deliberately minimal: one line saying who you play and when it ends, one big Play button, and the full
// bracket only behind "See bracket". It reads its own state from the server (fetchMyTournamentState).
const DECIDED_BY_TEXT = {
    score: 'more correct answers', time: 'the faster time', random: 'a random decider after an exact tie',
    walkover: 'a missed deadline', bye: 'a free pass', none: 'no one played',
};

export function GuildEventTournamentPanel({ event, myUserId, hasPaidEntry }) {
    const [t, setT] = useState(undefined);
    const [session, setSession] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [showBracket, setShowBracket] = useState(false);
    // Unsent answers survive a failed submit (see GuildEventQuizPanel): retry instead of forfeiting the match.
    const [unsent, setUnsent] = useState(null); // { matchId, answers, tabSwitches }

    const load = () => fetchMyTournamentState(event.id).then(setT);
    useEffect(() => {
        load();
        // A round can be decided at any minute by the server's job; a slow refresh keeps the screen honest.
        const timer = setInterval(load, 60000);
        return () => clearInterval(timer);
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [event.id]);

    if (!hasPaidEntry) return null;
    if (t === undefined) return React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}`, fontSize: TYPE_SCALE[13], color: C.textMuted } }, 'Loading\u2026');
    if (!t) return null; // no tournament settings on file, or not an entrant

    const match = t.myMatch || null;

    const handleStart = async () => {
        setBusy(true);
        setError(null);
        try {
            const s = await startTournamentMatch(match.id);
            if (!s.questions.length) throw new Error('This match has no questions.');
            setSession({ matchId: match.id, questions: s.questions, deadlineMs: Date.now() + s.remainingSeconds * 1000 });
        } catch (e) {
            setError(e.message || 'Could not start the match.');
            load();
        } finally {
            setBusy(false);
        }
    };

    // Answers and the tab-switch count only - the server grades, times and shuffles; nothing is scored here.
    const handleFinish = async ({ answers, tabSwitches }, matchIdOverride) => {
        const matchId = matchIdOverride || (session && session.matchId);
        setBusy(true);
        setError(null);
        try {
            await submitTournamentMatch(matchId, answers, tabSwitches);
            setUnsent(null);
            clearSavedQuiz('inkroot:match-progress:' + matchId);
        } catch (e) {
            setUnsent({ matchId, answers, tabSwitches });
            setError((e.message || 'Could not submit your answers.') + ' Your answers are saved on this screen \u2014 tap Retry submit before the clock runs out.');
        } finally {
            setSession(null);
            setBusy(false);
            load();
        }
    };

    // ---- Presentation only: state, handlers and server calls above are unchanged. ----
    const scores = (m) => (m.myScore != null && m.opponentScore != null ? React.createElement(ScoreLine, { mine: m.myScore, theirs: m.opponentScore, decidedBy: m.decidedBy }) : null);
    let matchNode = null;
    if (session) {
        matchNode = React.createElement(QuizPlayer, { questions: session.questions, deadlineMs: session.deadlineMs, trackFocus: true, onFinish: handleFinish, busy, saveKey: 'inkroot:match-progress:' + session.matchId });
    } else if (t.status === 'no_contest') {
        matchNode = React.createElement(StatusCard, { tone: 'neutral', icon: 'shield', title: 'This tournament ended without a winner' });
    } else if (!t.entriesClosed) {
        matchNode = React.createElement(StatusCard, { tone: 'info', icon: 'hourglass', title: 'Waiting for the bracket', sub: event.end_date ? `Your match appears here as soon as entries close \u2014 set for ${formatEventDate(event.end_date)}, unless the host closes them sooner.` : 'Your match appears here as soon as entries close.' });
    } else if (!match) {
        matchNode = React.createElement(StatusCard, { tone: 'neutral', icon: 'shield', title: 'You\u2019re not in this round' });
    } else if (match.status === 'lost') {
        matchNode = React.createElement(StatusCard, { tone: 'out', icon: 'crossedSwords', title: 'You\u2019re out' }, scores(match));
    } else if (match.status === 'won') {
        matchNode = React.createElement(StatusCard, { tone: 'success', icon: t.status === 'finished' ? 'trophy' : 'star', title: React.createElement(IconText, { icon: 'check', size: 16, strokeWidth: 2.4, gap: 6 }, t.status === 'finished' ? 'You won the tournament' : 'You moved on') },
            scores(match),
            match.myScore != null && match.opponentScore == null && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginTop: 3 } }, 'Your opponent didn\u2019t play, so you advance.'));
    } else if (match.status === 'bye') {
        matchNode = React.createElement(StatusCard, { tone: 'success', icon: 'star', title: React.createElement(IconText, { icon: 'check', size: 16, strokeWidth: 2.4, gap: 6 }, 'Free pass \u2014 you move on') });
    } else if (match.status === 'submitted') {
        matchNode = React.createElement(StatusCard, { tone: 'success', icon: 'hourglass', title: React.createElement(IconText, { icon: 'check', size: 16, strokeWidth: 2.4, gap: 6 }, 'Done \u2014 waiting for the result'),
            sub: match.myScore != null ? `You got ${match.myScore} of ${match.total} right. The result is decided at the deadline.` : null },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, marginTop: 6 } }, React.createElement(RoundCountdown, { deadline: match.deadline })));
    } else {
        let myName = 'You';
        for (const round of (t.bracket || [])) {
            for (const m of round) {
                const mine = [m.a, m.b].find((x) => x && !x.bye && x.userId === myUserId);
                if (mine && mine.name) myName = mine.name;
            }
        }
        const oppName = match.opponent && match.opponent.name ? match.opponent.name : 'your opponent';
        const side = (label, name, mine) => React.createElement("div", { style: { flex: 1, minWidth: 0, textAlign: 'center' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 } }, label),
            React.createElement("div", { style: { fontFamily: tnSerif, fontSize: TYPE_SCALE[17], lineHeight: 1.25, color: mine ? C.goldBright : C.textStrong, overflowWrap: 'anywhere' } }, name));
        matchNode = React.createElement("div", { style: { ...tnCardStyle, padding: 16, borderRadius: RADIUS_SCALE[12], textAlign: 'center', borderColor: goldA(0.35), background: `linear-gradient(160deg, ${C.surfaceRaised}, ${C.surfaceAlt})` } },
            React.createElement("span", { style: tnPill(C.goldBright) }, `${roundLabel(match.round, t.bracketRounds || t.rounds)} \u2014 your match`),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], margin: '14px 0 12px' } },
                side('You', myName, true),
                React.createElement("span", { "aria-hidden": "true", style: { flexShrink: 0, width: 32, height: 32, borderRadius: RADIUS_SCALE[999], display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[13], fontStyle: 'italic', color: C.textSoft, border: `1px solid ${C.borderStrong}` } }, 'vs'),
                side('Opponent', oppName, false)),
            React.createElement("div", { style: { display: 'inline-block', padding: '6px 14px', marginBottom: 14, borderRadius: RADIUS_SCALE[100], background: C.panel, border: `1px solid ${C.border}`, fontSize: TYPE_SCALE[13], fontWeight: 600 } },
                React.createElement(RoundCountdown, { deadline: match.deadline })),
            React.createElement("button", { disabled: busy, onClick: handleStart, style: { ...evBtnStyle(true), width: '100%', minHeight: 56, padding: '16px 0', fontSize: TYPE_SCALE[16] || 16, borderRadius: RADIUS_SCALE[12], opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : React.createElement(IconText, { icon: 'play', size: 16, gap: 8 }, match.started ? 'Resume' : 'Play')),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textSoft, marginTop: 10, lineHeight: 1.45 } },
                match.started ? 'You\u2019ve already started \u2014 your clock is running.' : 'One try, one overall clock that starts when you tap Play. Play any time before the deadline.'),
            !match.started && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.textMuted, marginTop: 8, lineHeight: 1.45 } },
                React.createElement(IconText, { icon: 'eye', size: 14, gap: 6, style: { verticalAlign: 'top' } }, 'Leaving this page during the match is noted for the hosts to review. Nobody is disqualified automatically.')));
    }

    const scheduleNode = t.entriesClosed && t.status !== 'no_contest' && Array.isArray(t.roundDeadlines) && t.roundDeadlines.length > 0
        && React.createElement(RoundTimeline, { deadlines: t.roundDeadlines, total: t.bracketRounds || t.rounds, currentRound: t.status === 'running' ? t.currentRound : null });

    // A real 1-2-3 podium: winner centred and tallest. Same three names as before, same medals.
    const podiumNode = t.podium && (() => {
        const slots = [{ k: 'second', i: 1, h: 52 }, { k: 'first', i: 0, h: 76 }, { k: 'third', i: 2, h: 38 }].filter((x) => t.podium[x.k]);
        const medalColors = [C.goldBright, C.medalSilver, C.medalBronze];
        return React.createElement("div", { style: { ...tnCardStyle, padding: '14px 10px 0', marginBottom: 12, borderRadius: RADIUS_SCALE[12], borderColor: goldA(0.4) } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: SPACE_SCALE[8] } },
                slots.map((x) => React.createElement("div", { key: x.k, style: { flex: 1, minWidth: 0, maxWidth: 120, textAlign: 'center' } },
                    React.createElement(InkIcon, { name: 'medal', size: 22, color: medalColors[x.i] }),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: C.text, margin: '4px 2px 6px', overflowWrap: 'anywhere', lineHeight: 1.3 } }, t.podium[x.k].name),
                    React.createElement("div", { "aria-hidden": "true", style: { height: x.h, borderRadius: `${RADIUS_SCALE[8]}px ${RADIUS_SCALE[8]}px 0 0`, background: `${medalColors[x.i]}22`, border: `1px solid ${medalColors[x.i]}55`, borderBottom: 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 6, fontFamily: tnSerif, fontSize: TYPE_SCALE[15], color: medalColors[x.i] } }, x.i + 1)))));
    })();

    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your tournament'),
        error && React.createElement("div", { style: S.errorText }, error),
        !session && unsent && React.createElement(QuizRetryBanner, { busy, onRetry: () => handleFinish({ answers: unsent.answers, tabSwitches: unsent.tabSwitches }, unsent.matchId) }),
        React.createElement("div", { style: { marginBottom: 12 } }, matchNode),
        scheduleNode,
        podiumNode,
        // The bracket is reference material, not the next action, so it sits behind the shared row (same show/hide state as before).
        t.entriesClosed && t.bracket && t.bracket.length > 0 && React.createElement(Fold, {
            icon: "crossedSwords", title: "Bracket", summary: `${t.bracket.length} round${t.bracket.length === 1 ? '' : 's'}`,
            open: showBracket, onToggle: () => setShowBracket((v) => !v), minHeight: 52, bodyGap: 10,
        }, React.createElement(BracketView, { bracket: t.bracket, myUserId, currentRound: t.status === 'running' ? t.currentRound : null })));
}

// ---------- Host / Inkroot: matches worth a look (tab switches) ----------
// A weak signal, never proof and never a violation: it only lists who left the match page while playing, so an
// officer can take a look before pressing "Work out the winners". Phone keyboards, notifications, pop-ups and
// incoming calls all count as leaving the page, so an innocent player can show several. Worded that way on
// purpose (roadmap 1.4) - never call this a flag of wrongdoing. Players never see these numbers.
export function TournamentReviewPanel({ event }) {
    const [rows, setRows] = useState(undefined);
    const [open, setOpen] = useState(false);
    useEffect(() => { if (open) fetchFlaggedTournamentAttempts(event.id).then(setRows); }, [open, event.id]);
    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("button", { onClick: () => setOpen((v) => !v), style: qzBtnStyle(false) }, open ? 'Hide matches worth a look' : 'Matches worth a look'),
        open && React.createElement("div", { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft } },
                'Players who left the page during a match. Worth a look, not proof: phone keyboards, notifications and pop-ups count too, and nobody is disqualified automatically.'),
            rows === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
            rows && rows.length === 0 && React.createElement("div", { style: S.noteItalic }, 'Nothing worth a look.'),
            (rows || []).map((r) => React.createElement("div", { key: `${r.matchId}-${r.playerId}`, style: { ...tnCardStyle, fontSize: TYPE_SCALE[13], color: C.text } },
                `${r.playerName} \u2014 round ${r.round}: left the page ${r.tabSwitches} time${r.tabSwitches === 1 ? '' : 's'}, ${r.correct} correct in ${(r.timeMs / 1000).toFixed(1)}s`))));
}
