import { S } from './guild-styles.js';
import { C, dangerA } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { EntrantResultStrip } from './guild-event-results-panels.jsx';
import { evTapBtn, evInputStyle, OBJECTIVE_METRIC_LABELS } from './guild-event-ui.jsx';
import { SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { storage } from '../lib/storage.js';
import { INDEX_KEY, projectKey } from '../shared-utils/storage-keys.jsx';
import { wordCount, stripHtml } from '../shared-utils/strip-html.jsx';


function countWords(text) {
    if (!text) return 0;
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Reads a .txt file's contents in the browser. Real, client-side, no backend involved — this is
// the one piece of the spec's "upload inline, .txt or .pdf" line that's fully buildable today.
function readTextFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error("Couldn't read that file."));
        reader.readAsText(file);
    });
}

// ---------------------------------------------------------------------------------------------
// BACKEND FLAGS — see Inkroot_Guild_Events_Redesign_Spec.docx, "Writing Events":
//
// 1. RESOLVED by 166_migration_guild_event_writing_word_range.sql: guild_events now has
//    min_word_count/max_word_count columns, create_guild_event_draft/update_guild_event_draft
//    accept + validate them, and lib/guild-events.js passes them through as event.minWordCount/
//    event.maxWordCount (still read defensively below — they're simply null when a host hasn't
//    set a range, same as before).
//
// 2. RESOLVED by the same migration: submit_guild_event_submission() now rejects an out-of-range
//    word count server-side, so the disabled-submit-button behavior below is backed by a real
//    check, not just a UX guard.
//
// 3. Upload is .txt only, by design — PDF was dropped from the spec.
//
// ---------------------------------------------------------------------------------------------
export function GuildEventWritingPanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined); // undefined = loading, null = none on file
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = none yet
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    // Spec: paste inline, upload .txt/.pdf, or link one of the entrant's own projects (word count
    // auto-pulled from the project's tracked chapters — never typed in, so it can't be fudged).
    const [useProject, setUseProject] = useState(false);
    const [projects, setProjects] = useState(undefined); // undefined = not loaded / loading
    const [selectedProjectId, setSelectedProjectId] = useState('');
    const [linked, setLinked] = useState(null); // { id, title, text, wordCount }
    const [projectError, setProjectError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [fileBusy, setFileBusy] = useState(false);
    const [fileError, setFileError] = useState(null);

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then((s) => {
            setSubmission(s);
            if (s) {
                setTitle(s.title || '');
                const c = s.content || {};
                if (c.projectId) {
                    setUseProject(true);
                    setLinked({ id: c.projectId, title: c.projectTitle || 'Untitled project', text: c.text || '', wordCount: s.word_count != null ? Number(s.word_count) : countWords(c.text || '') });
                    setSelectedProjectId(c.projectId);
                } else {
                    setUseProject(false);
                    setContent(c.text || '');
                }
            }
        }).catch(() => setSubmission(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const liveWordCount = useProject ? (linked ? linked.wordCount : 0) : countWords(content);

    // BACKEND FLAG (1) above — always undefined today.
    const minWords = event.minWordCount != null ? Number(event.minWordCount) : null;
    const maxWords = event.maxWordCount != null ? Number(event.maxWordCount) : null;
    const hasRange = minWords != null || maxWords != null;
    const outOfRange = hasRange
        && ((minWords != null && liveWordCount < minWords) || (maxWords != null && liveWordCount > maxWords));

    const formOpen = approvalStatus === 'active' && (editing || submission === null);
    useEffect(() => {
        if (!formOpen || !useProject || projects !== undefined) return;
        let cancelled = false;
        storage.get(INDEX_KEY).then((res) => {
            if (!cancelled) setProjects(res ? (JSON.parse(res.value) || []) : []);
        }).catch((e) => {
            if (!cancelled) { setProjectError(e.message || "Couldn't load your projects."); setProjects([]); }
        });
        return () => { cancelled = true; };
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [formOpen, useProject]);

    const handlePickProject = async (id) => {
        setSelectedProjectId(id);
        setLinked(null);
        setProjectError(null);
        if (!id) return;
        try {
            const res = await storage.get(projectKey(id));
            const proj = res ? JSON.parse(res.value) : null;
            if (!proj) { setProjectError("Couldn't open that project."); return; }
            const chapters = proj.chapters || [];
            const total = chapters.reduce((sum, c) => sum + wordCount(c.text), 0);
            // Plain text, not the chapters' stored HTML: judges read this as text, so raw <div> tags would
            // show up in front of them. The server counts words the same way either way (every tag is
            // whitespace to it), so the range check is unaffected.
            const text = chapters.map((c) => stripHtml(c.text || '').trim()).filter(Boolean).join('\n\n');
            setLinked({ id, title: proj.title || 'Untitled project', text, wordCount: total });
        } catch (err) {
            setProjectError(err.message || "Couldn't open that project.");
        }
    };

    const handleFileChange = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // lets the same file be re-selected after an error
        if (!file) return;
        setFileError(null);
        const name = file.name.toLowerCase();
        if (!(name.endsWith('.txt') || file.type === 'text/plain')) {
            setFileError('Only .txt files can be uploaded \u2014 paste your entry, or link one of your projects.');
            return;
        }
        setFileBusy(true);
        try {
            const text = await readTextFile(file);
            setUseProject(false);
            setContent(text);
        } catch (err) {
            setFileError(err.message || "Couldn't read that file.");
        } finally {
            setFileBusy(false);
        }
    };

    const handleSubmit = async () => {
        if (!useProject && !content.trim()) { setError('Add your entry, or link one of your projects.'); return; }
        if (useProject && !linked) { setError('Choose a project to link, or paste your entry directly.'); return; }
        if (outOfRange) {
            setError(
                minWords != null && maxWords != null ? `This entry needs to be between ${minWords} and ${maxWords} words.`
                    : minWords != null ? `This entry needs at least ${minWords} words.`
                        : `This entry needs to stay under ${maxWords} words.`
            );
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const submittedContent = useProject
                ? { text: linked.text, projectId: linked.id, projectTitle: linked.title }
                : { text: content };
            await submitGuildEventSubmission(event.id, { title, wordCount: liveWordCount, content: submittedContent });
            setEditing(false);
            load();
        } catch (e) {
            setError(e.message || 'Could not submit your entry.');
        } finally {
            setBusy(false);
        }
    };

    // The line shown while the event is open; once it is completed EntrantResultStrip shows the entrant's own result instead.
    const activeNode = approvalStatus !== 'active' || submission === undefined ? null
        : submission
            ? React.createElement("div", { style: S.successNote },
                `\u2713 Submitted${submission.updated_at ? ` \u2014 last updated ${new Date(submission.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`)
            : React.createElement("div", { style: S.goldNote }, 'Not submitted yet');


    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your entry'),

        config && React.createElement("div", { style: S.softHintLoose },
            config.weight_bps >= 10000
                ? `Judged purely on ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()} \u2014 no judge panel.`
                : config.weight_bps <= 0
                    ? 'Judged blind by a panel of Inkroot judges, outside this guild.'
                    : `${config.weight_bps / 100}% ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()}, ${100 - config.weight_bps / 100}% blind Inkroot judges.`),

        // ---------- Word-range banner \u2014 see BACKEND FLAG (1) above ----------
        approvalStatus === 'active' && hasRange && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginBottom: 10 } },
            (minWords != null && maxWords != null ? `Entries must be between ${minWords} and ${maxWords} words.`
                    : minWords != null ? `Entries must be at least ${minWords} words.`
                        : `Entries must stay under ${maxWords} words.`)),

        React.createElement(EntrantResultStrip, { event, activeNode }),


        error && React.createElement("div", { style: S.errorText }, error),

        // ---------- Submission form ----------
        approvalStatus === 'active' && (editing || !submission)
            ? React.createElement("div", null,
                React.createElement("div", { style: { marginBottom: 8 } },
                    React.createElement("label", { style: S.capsLabel }, 'Title'),
                    React.createElement("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Give your entry a title", style: evInputStyle })),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 8, flexWrap: 'wrap' } },
                    React.createElement("button", { onClick: () => setUseProject(false), style: { ...evTapBtn(!useProject), flex: 1 } }, 'Paste or upload'),
                    React.createElement("button", { onClick: () => setUseProject(true), style: { ...evTapBtn(useProject), flex: 1 } }, 'Link a project')),
                fileError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[10.5], marginBottom: 8 } }, fileError),
                !useProject
                    ? React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: { ...evTapBtn(false), display: 'inline-flex', alignItems: 'center', marginBottom: 8, cursor: fileBusy ? 'default' : 'pointer', opacity: fileBusy ? 0.5 : 1 } },
                            fileBusy ? 'Reading\u2026' : 'Upload a .txt file',
                            React.createElement("input", { type: "file", accept: ".txt,text/plain", onChange: handleFileChange, disabled: fileBusy, style: { display: 'none' } })),
                        React.createElement("label", { style: S.capsLabel }, `Entry \u2014 ${liveWordCount} word${liveWordCount === 1 ? '' : 's'}${outOfRange ? ' \u2014 out of range' : ''}`),
                        React.createElement("textarea", {
                            value: content, onChange: (e) => setContent(e.target.value), rows: 8,
                            placeholder: "Paste your entry here\u2026",
                            style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit', border: outOfRange ? `1px solid ${dangerA(0.6)}` : evInputStyle.border },
                        }))
                    : React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: S.capsLabel }, 'Project'),
                        projects === undefined && !projectError
                            ? React.createElement("div", { style: S.note }, 'Loading your projects\u2026')
                            : React.createElement("select", { value: selectedProjectId, onChange: (e) => handlePickProject(e.target.value), style: evInputStyle },
                                React.createElement("option", { value: "" }, (projects || []).length ? 'Choose a project' : 'No projects found'),
                                (projects || []).map((p) => React.createElement("option", { key: p.id, value: p.id }, p.title || 'Untitled project'))),
                        projectError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[10.5], marginTop: 6 } }, projectError),
                        linked && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], marginTop: 8, color: outOfRange ? C.danger : C.textDim } },
                            `${linked.title} \u2014 ${linked.wordCount.toLocaleString()} word${linked.wordCount === 1 ? '' : 's'}${outOfRange ? ' \u2014 out of range' : ''}`),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: C.textMuted, marginTop: 4 } }, 'Word count is read from the project itself. Your entry is a snapshot of it taken when you submit.')),
                React.createElement("div", { style: S.row8 },
                    React.createElement("button", { disabled: busy || outOfRange, onClick: handleSubmit, style: { ...evTapBtn(true, true), flex: 1, opacity: (busy || outOfRange) ? 0.5 : 1 } }, busy ? '\u2026' : (submission ? 'Save changes' : 'Submit entry')),
                    submission && editing && React.createElement("button", { onClick: () => setEditing(false), style: evTapBtn(false, true) }, 'Cancel')))
            : approvalStatus === 'active' && submission && React.createElement("button", { onClick: () => setEditing(true), style: evTapBtn(false) }, 'Edit entry'));
}
