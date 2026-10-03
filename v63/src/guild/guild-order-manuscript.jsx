import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useState, useEffect } from 'react';
import { addGuildPassage, deleteGuildChapter, fetchGuildManuscript, proposeGuildChapter, setGuildChapterStatus, subscribeGuildManuscriptRealtime } from '../lib/guild-manuscript.js';
import { addGuildWorldEntry, fetchGuildWorldEntries, subscribeGuildWorldBibleRealtime } from '../lib/guild-world-bible.js';
import { currentUser } from '../lib/supabaseClient.js';
import { ConfirmDialog } from '../shared-ui/ui-primitives.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { GO_PERMISSIONS, GO_WORLD_CATEGORIES, GoLocked, goBtnStyle, goInputStyle } from './guild-order-core.jsx';

// Real shared manuscript — fetches from guild_order_chapters/guild_order_passages (migration 65)
// itself rather than being handed `chapters` from the simulated goBuildManuscript(roster) the way
// this tab used to be. guildId is whichever real id this guild type actually has (a Founder
// Guild's fixed key or a Player Guild's real uuid); guildType is 'founder'/'player', matching the
// migration's own discriminator column.
export function GoManuscriptTab({ guild, guildType, guildId, playerRung }) {
    const [state, setState] = useState({ loading: true, chapters: [] });
    const [newTitle, setNewTitle] = useState('');
    const [showNewChapter, setShowNewChapter] = useState(false);
    const [openChapter, setOpenChapter] = useState(null);
    const [pendingDelete, setPendingDelete] = useState(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const canDraft = playerRung >= GO_PERMISSIONS.draftChapter;

    useEffect(() => { currentUser().then((u) => setMyUserId(u && u.id)).catch(() => {}); }, []);

    const reload = () => {
        if (!guildId) { setState({ loading: false, chapters: [] }); return Promise.resolve(); }
        return fetchGuildManuscript(guildType, guildId).then((chapters) => setState({ loading: false, chapters }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, chapters: [] });
        (guildId ? fetchGuildManuscript(guildType, guildId) : Promise.resolve([]))
            .then((chapters) => { if (!cancelled) setState({ loading: false, chapters }); })
            .catch(() => { if (!cancelled) setState({ loading: false, chapters: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    // Live sync (migration 66): another real member proposing a chapter, adding a passage, or
    // advancing a status shows up here without waiting for this device's own next action —
    // reload() re-fetches the whole manuscript rather than trying to merge the changed row in,
    // same "cheap to recompute, simpler than patching" call subscribeFiresideRealtime's own
    // comment makes for the Fireside.
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildManuscriptRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const runAction = (fn) => {
        setBusy(true); setActionError(null);
        fn().then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusy(false));
    };
    const submitNewChapter = () => {
        if (!newTitle.trim()) return;
        runAction(() => proposeGuildChapter(guildType, guildId, newTitle).then(() => { setNewTitle(''); setShowNewChapter(false); }));
    };
    const submitPassage = (chId) => {
        if (!draft.trim()) return;
        runAction(() => addGuildPassage(chId, draft).then(() => setDraft('')));
        setOpenChapter(null);
    };
    const advance = (chId, current) => {
        const next = current === 'draft' ? 'in review' : 'approved';
        runAction(() => setGuildChapterStatus(chId, next));
    };
    // Only the proposer, and only while it's still a draft (see guild_order_chapters' own delete
    // policy) — once it moves to review/approved, other members may have added passages to it,
    // so there's no client-side way around the server enforcing this the same way.
    const removeChapter = (chId) => setPendingDelete(chId);
    const confirmRemoveChapter = () => {
        const chId = pendingDelete;
        setPendingDelete(null);
        if (chId) runAction(() => deleteGuildChapter(chId));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: C.textMuted, fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the manuscript\u2026");
    }
    return React.createElement("div", null,
        React.createElement("div", { style: { textAlign: 'center', fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[16], color: C.text, marginBottom: 4 } }, `${guild.name}: A Chronicle Unwritten`),
        React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11.5], color: C.textMuted, marginBottom: 18 } }, "A real, shared manuscript \u2014 every chapter and passage below is written by an actual guild member, live as they add it."),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: C.copperLight, marginBottom: 12 } }, actionError),
        canDraft
            ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
                React.createElement("button", { onClick: () => setShowNewChapter((s) => !s), style: goBtnStyle(true) }, showNewChapter ? 'Cancel' : '+ Propose a chapter'))
            : React.createElement(GoLocked, { text: 'Writers and above may propose new chapters.' }),
        showNewChapter && React.createElement("div", { style: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("input", { value: newTitle, onChange: (e) => setNewTitle(e.target.value), placeholder: 'Chapter title', style: goInputStyle }),
            React.createElement("button", { disabled: busy, onClick: submitNewChapter, style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, "Propose")),
        state.chapters.length === 0 && React.createElement("div", { style: S.emptyBlock }, "No chapters yet \u2014 be the first to propose one."),
        state.chapters.map((ch) => {
            const statusColor = ch.status === 'approved' ? C.success : ch.status === 'in review' ? C.gold : C.neutralMid;
            return React.createElement("div", { key: ch.id, style: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 12 } },
                React.createElement("div", { style: S.rowBetween },
                    React.createElement("div", null,
                        React.createElement("div", { style: S.noteSmall }, `Proposed by ${ch.proposerName}`),
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], color: C.text, fontWeight: 600 } }, ch.title)),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: statusColor, border: `1px solid ${statusColor}55`, borderRadius: RADIUS_SCALE[5], padding: '3px 7px', whiteSpace: 'nowrap' } }, ch.status)),
                ch.passages.length > 0 && React.createElement("div", { style: { marginTop: 10, borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[7] } },
                    ch.passages.map((p) => React.createElement("div", { key: p.id, style: { fontSize: TYPE_SCALE[11.5], color: '#B9B2A0', lineHeight: 1.5 } },
                        React.createElement("span", { style: { color: C.textSoft, fontStyle: 'italic' } }, `${p.authorName}: `), `\u201C${p.content}\u201D`))),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
                    canDraft && React.createElement("button", { onClick: () => setOpenChapter(openChapter === ch.id ? null : ch.id), style: goBtnStyle(false) }, openChapter === ch.id ? 'Cancel' : 'Add your passage'),
                    canDraft && ch.status !== 'approved' && React.createElement("button", { disabled: busy, onClick: () => advance(ch.id, ch.status), style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, ch.status === 'draft' ? 'Send to review' : 'Approve chapter'),
                    ch.status === 'draft' && ch.proposed_by === myUserId && React.createElement("button", { disabled: busy, onClick: () => removeChapter(ch.id), style: { ...goBtnStyle(false), color: C.copper } }, "Delete")),
                openChapter === ch.id && React.createElement("div", { style: { marginTop: 10 } },
                    React.createElement("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: "Write your contribution\u2026", rows: 3, style: goInputStyle }),
                    React.createElement("button", { disabled: busy, onClick: () => submitPassage(ch.id), style: { ...goBtnStyle(true), marginTop: 8, opacity: busy ? 0.5 : 1 } }, "Save to the manuscript")));
        }),
        React.createElement("div", { style: S.noteCaption }, "Approving a chapter needs real standing in the guild \u2014 an established Founder Guild member, or a Player Guild's owner/treasurer/officer."),
        pendingDelete && React.createElement(ConfirmDialog, {
            message: 'Delete this chapter? This cannot be undone.', confirmLabel: 'Delete chapter',
            onCancel: () => setPendingDelete(null), onConfirm: confirmRemoveChapter,
        }));
}


// Real World Bible — fetches from guild_order_world_entries (migration 81) itself rather than
// being handed `state.worldEntries`/`GO_WORLD_SEED` the way this tab used to be. guild/guildType/
// guildId/playerRung/playerName are exactly the same real props GoManuscriptTab above already
// takes, not this hook's own async state — same real-for-both-guild-types shape Manuscript
// already established.
export function GoWorldBibleTab({ guild, guildType, guildId, playerRung, playerName }) {
    const [state, setState] = useState({ loading: true, entries: [] });
    const [form, setForm] = useState({ category: GO_WORLD_CATEGORIES[0], title: '', blurb: '' });
    const [showForm, setShowForm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    const canAdd = playerRung >= GO_PERMISSIONS.addWorldEntry;

    const reload = () => {
        if (!guildId) { setState({ loading: false, entries: [] }); return Promise.resolve(); }
        return fetchGuildWorldEntries(guildType, guildId).then((entries) => setState({ loading: false, entries }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, entries: [] });
        (guildId ? fetchGuildWorldEntries(guildType, guildId) : Promise.resolve([]))
            .then((entries) => { if (!cancelled) setState({ loading: false, entries }); })
            .catch(() => { if (!cancelled) setState({ loading: false, entries: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    // Live sync (migration 81, shipped alongside the table itself) — another real member's new
    // entry shows up here without waiting for this device's own next action, same
    // "cheap to recompute, simpler than patching" reload()-on-change call Manuscript's own
    // subscribeGuildManuscriptRealtime already makes.
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildWorldBibleRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const submit = () => {
        if (!form.title.trim()) return;
        setBusy(true); setActionError(null);
        addGuildWorldEntry(guildType, guildId, form)
            .then(reload)
            .then(() => { setForm({ category: GO_WORLD_CATEGORIES[0], title: '', blurb: '' }); setShowForm(false); })
            .catch((e) => setActionError(e.message || 'That didn\u2019t go through.'))
            .finally(() => setBusy(false));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: C.textMuted, fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the World Bible\u2026");
    }
    return React.createElement("div", null,
        canAdd ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
            React.createElement("button", { onClick: () => setShowForm((s) => !s), style: goBtnStyle(true) }, showForm ? 'Cancel' : '+ Add an entry'))
            : React.createElement(GoLocked, { text: 'Writers and above can add entries to the shared World Bible.' }),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: C.copperLight, marginBottom: 12 } }, actionError),
        showForm && React.createElement("div", { style: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("select", { value: form.category, onChange: (e) => setForm({ ...form, category: e.target.value }), style: goInputStyle },
                GO_WORLD_CATEGORIES.map((c) => React.createElement("option", { key: c, value: c }, c))),
            React.createElement("input", { value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }), placeholder: 'Entry title', style: goInputStyle }),
            React.createElement("textarea", { value: form.blurb, onChange: (e) => setForm({ ...form, blurb: e.target.value }), placeholder: "A few sentences\u2026", rows: 3, style: goInputStyle }),
            React.createElement("button", { disabled: busy, onClick: submit, style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, "Add to the World Bible")),
        state.entries.length === 0 && React.createElement("div", { style: S.emptyBlock }, "No entries yet \u2014 be the first to add one."),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: SPACE_SCALE[12] } },
            state.entries.map((e) => React.createElement("div", { key: e.id, style: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[11], padding: 15 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], textTransform: 'uppercase', letterSpacing: '0.06em', color: '#A184D6', marginBottom: 6 } }, e.category),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], fontWeight: 600, color: C.text, marginBottom: 5 } }, e.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, lineHeight: 1.55, marginBottom: 8 } }, e.blurb),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: C.textMuted } }, `Contributed by ${e.authorName}`)))),
        React.createElement("div", { style: S.noteCaption }, "Every entry here is real \u2014 written by an actual guild member, live as they add it."));
}
