import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect } from 'react';
import { castGuildVote, closeGuildProposal, fetchGuildProposals, openGuildProposal, subscribeGuildCouncilRealtime } from '../lib/guild-order-council.js';
import { currentUser } from '../lib/supabaseClient.js';
import { ProgressBar } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { GO_PERMISSIONS, GoLocked, goBtnStyle, goInputStyle } from './guild-order-core.jsx';

export function GoCouncilTab({ guildType, guildId, playerRung, playerName }) {
    const [state, setState] = useState({ loading: true, proposals: [] });
    const [draft, setDraft] = useState({ title: '', body: '' });
    const [showForm, setShowForm] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const canPropose = playerRung >= GO_PERMISSIONS.openVote;

    useEffect(() => { currentUser().then((u) => setMyUserId(u && u.id)).catch(() => {}); }, []);

    const reload = () => {
        if (!guildId) { setState({ loading: false, proposals: [] }); return Promise.resolve(); }
        return fetchGuildProposals(guildType, guildId).then((proposals) => setState({ loading: false, proposals }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, proposals: [] });
        (guildId ? fetchGuildProposals(guildType, guildId) : Promise.resolve([]))
            .then((proposals) => { if (!cancelled) setState({ loading: false, proposals }); })
            .catch(() => { if (!cancelled) setState({ loading: false, proposals: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildCouncilRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const raiseProposal = () => {
        if (!draft.title.trim()) return;
        setBusyId('new'); setActionError(null);
        openGuildProposal(guildType, guildId, draft)
            .then(reload)
            .then(() => { setDraft({ title: '', body: '' }); setShowForm(false); })
            .catch((e) => setActionError(e.message || 'That didn\u2019t go through.'))
            .finally(() => setBusyId(null));
    };
    const vote = (proposalId, choice) => {
        setBusyId(proposalId); setActionError(null);
        castGuildVote(proposalId, choice).then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };
    const close = (proposalId) => {
        setBusyId(proposalId); setActionError(null);
        closeGuildProposal(proposalId).then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: C.textMuted, fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the Council chamber\u2026");
    }
    const open = state.proposals.filter((p) => p.status === 'open');
    const closed = state.proposals.filter((p) => p.status === 'closed');

    const renderProposal = (p) => {
        const total = p.total || 0;
        const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
        return React.createElement("div", { key: p.id, style: { background: C.surface, border: p.status === 'open' ? '1px solid rgba(232,196,104,0.3)' : `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 18, marginBottom: 14 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], textTransform: 'uppercase', letterSpacing: '0.1em', color: p.status === 'open' ? C.goldBright : C.neutral, marginBottom: 8 } }, p.status === 'open' ? 'Active Proposal' : 'Closed'),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], color: C.text, fontWeight: 600, marginBottom: 6 } }, p.title),
            p.body && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, marginBottom: 14, lineHeight: 1.55 } }, p.body),
            ['yes', 'no', 'abstain'].map((choice) => React.createElement("div", { key: choice, style: { marginBottom: 8 } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[11.5], color: C.textSoft, marginBottom: 3 } },
                    React.createElement("span", null, choice === 'yes' ? 'For' : choice === 'no' ? 'Against' : 'Abstain'), React.createElement("span", null, `${pct(p.tally[choice])}%`)),
                React.createElement(ProgressBar, { value: p.tally[choice], max: Math.max(total, 1), color: choice === 'yes' ? C.success : choice === 'no' ? C.copper : C.neutral }))),
            p.status === 'open' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 14 } },
                ['yes', 'no', 'abstain'].map((choice) => React.createElement("button", { key: choice, disabled: busyId === p.id, onClick: () => vote(p.id, choice), style: { ...goBtnStyle(p.myVote === choice), flex: 1, opacity: busyId === p.id ? 0.5 : 1 } }, choice === 'yes' ? 'Vote For' : choice === 'no' ? 'Vote Against' : 'Abstain'))),
            p.myVote && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 10 } }, `Your vote is recorded as "${p.myVote}."`),
            React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 6 } }, `Opened by ${p.openedByName}${total > 0 ? ` \u00b7 ${total} vote${total === 1 ? '' : 's'}` : ''}`),
            p.status === 'open' && p.opened_by === myUserId && React.createElement("div", { style: { textAlign: 'center', marginTop: 10 } },
                React.createElement("button", { disabled: busyId === p.id, onClick: () => close(p.id), style: { background: 'none', border: 'none', color: '#7A4A3A', fontSize: TYPE_SCALE[11], cursor: 'pointer', textDecoration: 'underline' } }, "Close this proposal")));
    };

    return React.createElement("div", null,
        canPropose ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
            React.createElement("button", { onClick: () => setShowForm((s) => !s), style: goBtnStyle(true) }, showForm ? 'Cancel' : '+ Raise a proposal'))
            : React.createElement(GoLocked, { text: 'Only the Council and Guild Master may raise new proposals.' }),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: C.copperLight, marginBottom: 12 } }, actionError),
        showForm && React.createElement("div", { style: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("input", { value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }), placeholder: 'Proposal title', style: goInputStyle }),
            React.createElement("textarea", { value: draft.body, onChange: (e) => setDraft({ ...draft, body: e.target.value }), placeholder: "What is the Council deciding\u2026?", rows: 2, style: goInputStyle }),
            React.createElement("button", { disabled: busyId === 'new', onClick: raiseProposal, style: { ...goBtnStyle(true), opacity: busyId === 'new' ? 0.5 : 1 } }, "Bring before the Council")),
        open.length === 0 && closed.length === 0 && React.createElement("div", { style: S.emptyBlock }, "No proposals yet \u2014 be the first to raise one."),
        open.map(renderProposal),
        closed.length > 0 && React.createElement("div", { style: { marginTop: open.length > 0 ? 10 : 0 } },
            React.createElement("div", { style: S.sectionLabel }, 'Past Proposals'),
            closed.map(renderProposal)),
        React.createElement("div", { style: S.noteCaption }, "Every proposal and vote here is real \u2014 cast by an actual guild member, live as they cast it."));
}
