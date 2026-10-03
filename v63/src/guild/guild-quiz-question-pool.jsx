import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import {
    fetchGuildBankCounts, fetchGuildBankQuestions, fetchInkrootBankCounts, fetchInkrootQuizBank,
    fetchMyGuildBankQuestions, fetchMyInkrootQuizQuestions, hostAddGuildBankQuestion,
    reviewGuildQuizQuestion, reviewInkrootQuizQuestion, suggestGuildBankQuestion, suggestInkrootQuizQuestion,
} from '../lib/guild-events.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { QuizQuestionForm, QuizQuestionRow } from './guild-event-quiz-panel.jsx';
import { evBtnStyle, evInputStyle } from './guild-event-ui.jsx';
import { SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------------------------------------------------------------------------------------------
// Question pool (backend spec section 2a, front-end). One component, two modes:
//   mode 'guild'   - a guild's shared bank (migration 174). Members suggest, officers approve.
//                    The bank is one of the guild's anthologies, or the general trivia bank.
//   mode 'inkroot' - the Inkroot-wide official bank (migration 179). Admins only; the server
//                    refuses an admin approving their own question.
// Everything here is display + calls to the existing lib wrappers. Who may suggest, who may review,
// the 10-waiting cap, the rate limit and the answer keys are all the server's; a refusal is shown
// with the server's own message. canReview only decides which controls are drawn.
// ---------------------------------------------------------------------------------------------

const GENERAL = 'general';
const poolLabelStyle = { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };
const linkBtnStyle = { background: 'none', border: 'none', color: C.textSoft, fontSize: TYPE_SCALE[11.5], cursor: 'pointer', padding: '4px 2px' };

export function QuestionPool({ mode = 'guild', guildId, canReview = false, members = [] }) {
    const isInkroot = mode === 'inkroot';
    const [books, setBooks] = useState([]);
    const [bank, setBank] = useState(GENERAL);
    const [view, setView] = useState('mine'); // 'mine' | 'review'
    const [counts, setCounts] = useState(undefined);
    const [mine, setMine] = useState(undefined);
    const [queue, setQueue] = useState(undefined);
    const [showForm, setShowForm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const bankArgs = bank === GENERAL ? { generalOnly: true } : { anthologyId: bank };
    const anthologyId = bank === GENERAL ? null : bank;

    useEffect(() => {
        if (isInkroot || !guildId) return;
        fetchGuildAnthologies(guildId).then((rows) => setBooks(rows || [])).catch(() => setBooks([]));
    }, [isInkroot, guildId]);

    const reload = () => {
        if (isInkroot) {
            fetchInkrootBankCounts().then(setCounts);
            fetchMyInkrootQuizQuestions().then(setMine);
            if (canReview) fetchInkrootQuizBank('pending').then(setQueue);
        } else {
            fetchGuildBankCounts(guildId, bankArgs).then(setCounts);
            fetchMyGuildBankQuestions(guildId).then(setMine);
            if (canReview) fetchGuildBankQuestions(guildId, bankArgs).then((rows) => setQueue(rows.filter((q) => q.status === 'pending')));
        }
    };
    useEffect(() => { reload(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [isInkroot, guildId, bank, canReview]);

    const guard = async (fn) => {
        setBusy(true);
        setError(null);
        try { await fn(); reload(); } catch (e) { setError(e.message || 'Something went wrong.'); } finally { setBusy(false); }
    };

    const nameOf = (id) => { const m = members.find((x) => x.user_id === id); return m ? (m.name || null) : null; };
    const bookTitle = (id) => { if (!id) return 'General trivia'; const b = books.find((x) => x.id === id); return b ? b.title : 'Book'; };

    const addQuestion = async (q) => {
        const payload = { text: q.text, options: q.options, correctOptionId: q.correctOptionId };
        if (isInkroot) await suggestInkrootQuizQuestion(payload);
        else if (canReview) await hostAddGuildBankQuestion(guildId, anthologyId, payload);
        else await suggestGuildBankQuestion(guildId, anthologyId, payload);
        setShowForm(false);
        reload();
    };

    const addLabel = isInkroot ? 'Suggest question' : (canReview ? 'Add question' : 'Suggest question');
    const approveQuestion = (q, approve) => guard(() => (isInkroot ? reviewInkrootQuizQuestion(q.id, approve) : reviewGuildQuizQuestion(q.id, approve)));

    const shownMine = (mine || []).filter((q) => isInkroot || bank === 'all' || (q.anthologyId || null) === anthologyId);
    const readyText = counts === undefined ? 'Loading\u2026'
        : counts === null ? 'Count unavailable'
        : `${counts.approved} approved${counts.pending ? `, ${counts.pending} waiting for review` : ''}`;

    return React.createElement("div", { style: S.col10 },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textDim } },
            isInkroot
                ? 'Official questions for Inkroot events. Any admin can suggest one; a different admin approves it.'
                : 'Multiple-choice questions any guild event can draw from. Members suggest, officers approve. A question you write keeps you out of events that use it.'),

        !isInkroot && React.createElement("div", null,
            React.createElement("label", { style: poolLabelStyle }, 'Question bank'),
            React.createElement("select", { value: bank, onChange: (e) => { setBank(e.target.value); setShowForm(false); }, style: evInputStyle },
                React.createElement("option", { value: GENERAL }, 'General trivia (no book)'),
                books.map((b) => React.createElement("option", { key: b.id, value: b.id }, b.title)))),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: C.text, fontWeight: 600 } }, readyText),

        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.danger } }, error),

        !showForm && React.createElement("button", { onClick: () => setShowForm(true), style: { ...evBtnStyle(true), width: '100%', padding: '11px 13px' } }, '+ Add a question'),
        showForm && React.createElement("div", null,
            React.createElement(QuizQuestionForm, { busy, submitLabel: addLabel, onSubmit: async (q) => { setBusy(true); try { await addQuestion(q); } finally { setBusy(false); } } }),
            React.createElement("button", { onClick: () => setShowForm(false), style: linkBtnStyle }, 'Cancel')),

        canReview && React.createElement("div", { style: S.row6 },
            React.createElement("button", { onClick: () => setView('mine'), style: { ...evBtnStyle(view === 'mine'), flex: 1 } }, 'My questions'),
            React.createElement("button", { onClick: () => setView('review'), style: { ...evBtnStyle(view === 'review'), flex: 1 } },
                queue && queue.length ? `To review (${queue.length})` : 'To review')),

        (!canReview || view === 'mine') && React.createElement("div", { style: S.col8 },
            !canReview && React.createElement("label", { style: poolLabelStyle }, 'My questions'),
            mine === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
            shownMine.map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: isInkroot ? null : bookTitle(q.anthologyId) })),
            mine && shownMine.length === 0 && React.createElement("div", { style: S.noteItalic },
                'You haven\u2019t written any questions here yet.')),

        canReview && view === 'review' && React.createElement("div", { style: S.col8 },
            queue === undefined && React.createElement("div", { style: S.note }, 'Loading\u2026'),
            (queue || []).map((q) => React.createElement(QuizQuestionRow, { key: q.id, question: q, authorName: isInkroot ? null : nameOf(q.authorId) },
                React.createElement("div", { style: S.rowCenter8 },
                    q.isMine
                        ? React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, fontStyle: 'italic' } }, 'Another admin needs to review your own question.')
                        : React.createElement("button", { disabled: busy, onClick: () => approveQuestion(q, true), style: evBtnStyle(true) }, 'Approve'),
                    !q.isMine && React.createElement("button", { disabled: busy, onClick: () => approveQuestion(q, false), style: evBtnStyle(false) }, 'Reject')))),
            queue && queue.length === 0 && React.createElement("div", { style: S.noteItalic }, 'Nothing waiting for review.')));
}
