import { S } from './guild-styles.js';
import { C } from './guild-theme.js';
import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { EntrantResultStrip } from './guild-event-results-panels.jsx';
import { evTapBtn } from './guild-event-ui.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { storage } from '../lib/storage.js';
import { INDEX_KEY, projectKey } from '../shared-utils/storage-keys.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { worldBibleEntries } from '../worldbuilding/book-cover.jsx';
import { WorldBibleBrowseList } from '../worldbuilding/world-bible-browse-list.jsx';
import { FamilyTreeGallery } from '../worldbuilding/family-tree-gallery.jsx';
import { RelationshipWeb } from '../worldbuilding/relationship-web.jsx';
import { buildFamilyGraph, familyTreeStatsForHouse } from '../worldbuilding/family-graph.jsx';
import { extractCoMentionEdges } from '../writing/project-schema-and-backups.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

const wbCardStyle = S.card;
// Tappable rows in the picker (project, map): sized for a thumb like the quiz options.
const wbChoiceStyle = { ...wbCardStyle, textAlign: 'left', cursor: 'pointer', color: C.text, fontSize: TYPE_SCALE[13.5], minHeight: 52, borderRadius: RADIUS_SCALE[12], display: 'flex', alignItems: 'center', width: '100%' };

const CATEGORY_META = {
    map: { label: 'Map' },
    familyTree: { label: 'Family Tree' },
    location: { label: 'Location' },
    relationshipWeb: { label: 'Relationship Web' },
};

// ---------------------------------------------------------------------------------------------
// This whole panel is possible with ZERO backend changes — unlike guild-event-writing-panel.jsx's
// word-range gap, there's nothing here to flag as missing server-side:
//   - The World Bible being picked from is the entrant's own local project data (maps,
//     characters, locations, houses/relationships) already stored client-side via
//     storage.get(INDEX_KEY) / storage.get(projectKey(id)) — see shared-utils/storage-keys.jsx.
//     No Supabase read is needed to browse it.
//   - guild_event_submissions.content is schema-less jsonb (see 121_migration_guild_event_fair_
//     judging.sql), so the picked piece's reference/snapshot (this file's `worldPiece` shape)
//     slots into the *existing* submitGuildEventSubmission(eventId, {title, wordCount, content})
//     RPC exactly like the writing-contest {text}/{link} shapes already do. No new columns, no
//     new RPC.
//   - The only real gap is upstream of this file: 'world_building' isn't (and per the redesign
//     decision, won't be) its own DB event_type — this panel is reached by repurposing the
//     already-allowed 'workshop' value instead. See EVENT_TYPE_LABELS' own comment in
//     guild-event-card.jsx for that decision.
// ---------------------------------------------------------------------------------------------

// The picker is four screens deep (project, kind of piece, the piece itself, review), so it says where you are. Steps already
// passed are tappable to go back (this replaces the two small "back" links); steps ahead are not, because each one needs the
// answer to the one before it. A line underneath keeps the choices made so far in view. Display and navigation only.
const PICKER_STEPS = ['Project', 'Type', 'Piece', 'Review'];
function PickerSteps({ step, onStep, detail }) {
    return React.createElement("nav", { "aria-label": "Submission steps", style: { marginBottom: 12 } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6] } },
            PICKER_STEPS.map((label, i) => {
                const done = i < step;
                const on = i === step;
                return React.createElement("button", {
                    key: label, type: "button", disabled: !done, onClick: () => onStep(i), "aria-current": on ? 'step' : undefined,
                    "aria-label": `Step ${i + 1} of ${PICKER_STEPS.length}: ${label}${done ? ', done, tap to go back' : on ? ', current' : ''}`,
                    style: {
                        flex: 1, minWidth: 0, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], padding: '0 4px',
                        borderRadius: RADIUS_SCALE[12], fontSize: TYPE_SCALE[13], fontWeight: on ? 700 : 500, fontFamily: 'inherit',
                        cursor: done ? 'pointer' : 'default', opacity: !done && !on ? 0.55 : 1,
                        color: on ? C.goldBright : (done ? C.success : C.textSoft), background: on ? `${C.goldBright}1A` : 'transparent',
                        border: `1px solid ${on ? `${C.goldBright}80` : (done ? `${C.success}55` : C.border)}`,
                    },
                },
                    React.createElement("span", { "aria-hidden": "true", style: {
                        width: 18, height: 18, flexShrink: 0, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700,
                        color: done ? C.brown : (on ? C.goldBright : C.textSoft), background: done ? C.success : 'transparent', border: `1px solid ${done ? C.success : (on ? C.goldBright : C.borderStrong)}`,
                    } }, done ? React.createElement(InkIcon, { name: 'check', size: 12, strokeWidth: 3 }) : i + 1),
                    React.createElement("span", { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label));
            })),
        detail && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textSoft, marginTop: 8, overflowWrap: 'anywhere' } }, detail));
}

// Read-only render of one submitted (or in-progress) World Bible piece — shared between this
// panel's own "what you submitted" reveal and the judge panel (guild-event-judge-panel.jsx
// imports this directly rather than re-deriving its own version), so a submission is never shown
// two different ways to two different viewers. For 'relationshipWeb' this literally re-mounts
// the real RelationshipWeb component fed by the stored snapshot — the same screen an entrant's
// own project workspace uses, not a redrawn approximation of it.
export function WorldPiecePreview({ worldPiece, compact }) {
    if (!worldPiece) return null;
    if (worldPiece.category === 'map') {
        return React.createElement("div", { style: wbCardStyle },
            worldPiece.imageUrl && React.createElement("img", { src: worldPiece.imageUrl, alt: "", style: { width: '100%', maxHeight: 220, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], marginBottom: 8, display: 'block' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontFamily: "'Fraunces', Georgia, serif", color: C.text } }, worldPiece.mapTitle || 'Untitled map'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginTop: 2 } }, `${worldPiece.pinCount || 0} pin${worldPiece.pinCount === 1 ? '' : 's'}`));
    }
    if (worldPiece.category === 'familyTree') {
        return React.createElement("div", { style: wbCardStyle },
            worldPiece.crestUrl && React.createElement("img", { src: worldPiece.crestUrl, alt: "", style: { width: 44, height: 44, borderRadius: '50%', objectFit: 'cover', marginBottom: 8, display: 'block' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontFamily: "'Fraunces', Georgia, serif", color: C.text } }, worldPiece.houseName || 'Untitled house'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginTop: 2 } },
                `${worldPiece.memberCount || 0} member${worldPiece.memberCount === 1 ? '' : 's'} \u00b7 ${worldPiece.generationCount || 0} generation${worldPiece.generationCount === 1 ? '' : 's'}`));
    }
    if (worldPiece.category === 'location') {
        return React.createElement("div", { style: wbCardStyle },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontFamily: "'Fraunces', Georgia, serif", color: C.text } }, worldPiece.locationName || 'Untitled location'),
            worldPiece.region && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginTop: 2 } }, worldPiece.region),
            worldPiece.snippet && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: C.textSoft, marginTop: 6 } }, worldPiece.snippet));
    }
    if (worldPiece.category === 'relationshipWeb') {
        return React.createElement("div", { style: wbCardStyle },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginBottom: 8 } },
                `${worldPiece.characterCount || 0} character${worldPiece.characterCount === 1 ? '' : 's'} \u00b7 ${worldPiece.relationshipCount || 0} relationship${worldPiece.relationshipCount === 1 ? '' : 's'}`),
            !compact && React.createElement("div", { style: { height: 'min(340px, 55vh)', border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], overflow: 'hidden' } },
                React.createElement(RelationshipWeb, {
                    characters: worldPiece.characters || [], autoEdges: worldPiece.autoEdges || [],
                    manualEdges: worldPiece.manualEdges || [], houses: worldPiece.houses || [],
                    onSelectCharacter: () => {},
                })));
    }
    return null;
}

export function GuildEventWorldBuildingPanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined);
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = none yet
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // ---------- Picker state — only ever populated while the picker is actually open ----------
    const [projects, setProjects] = useState(undefined); // undefined = loading, [] = none
    const [projectsError, setProjectsError] = useState(null);
    const [selectedProjectId, setSelectedProjectId] = useState('');
    const [project, setProject] = useState(undefined); // undefined = none loaded, null = failed to load
    const [category, setCategory] = useState(null);
    const [pending, setPending] = useState(null); // staged selection, shown for confirmation before submit

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then(setSubmission).catch(() => setSubmission(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const pickerOpen = approvalStatus === 'active' && (editing || submission === null);

    // Loads the entrant's own local project index the moment the picker is actually opened —
    // never on first mount, so simply viewing a completed event's results doesn't touch
    // IndexedDB for no reason.
    useEffect(() => {
        if (!pickerOpen) return;
        let cancelled = false;
        setProjects(undefined);
        setProjectsError(null);
        storage.get(INDEX_KEY).then((res) => {
            if (cancelled) return;
            setProjects(res ? (JSON.parse(res.value) || []) : []);
        }).catch((e) => {
            if (cancelled) return;
            setProjectsError(e.message || "Couldn't load your projects.");
            setProjects([]);
        });
        return () => { cancelled = true; };
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [pickerOpen]);

    useEffect(() => {
        if (!selectedProjectId) { setProject(undefined); return; }
        let cancelled = false;
        setProject(undefined);
        setCategory(null);
        setPending(null);
        storage.get(projectKey(selectedProjectId)).then((res) => {
            if (cancelled) return;
            setProject(res ? JSON.parse(res.value) : null);
        }).catch(() => { if (!cancelled) setProject(null); });
        return () => { cancelled = true; };
    }, [selectedProjectId]);

    const resetPicker = () => { setSelectedProjectId(''); setProject(undefined); setCategory(null); setPending(null); setError(null); };
    // 0 project, 1 type, 2 piece, 3 review - derived from what has been chosen, never stored separately.
    const pickerStep = !selectedProjectId ? 0 : !category ? 1 : !pending ? 2 : 3;
    const goPickerStep = (i) => {
        setError(null);
        if (i === 0) resetPicker();
        else if (i === 1) { setCategory(null); setPending(null); }
        else if (i === 2) setPending(null);
    };

    const handleSubmitPending = async () => {
        if (!pending) return;
        setBusy(true);
        setError(null);
        try {
            // No title field, no manuscript, no publishing fields — per the redesign spec. The
            // entry's own name (house/map/location name, or nothing for a whole relationship web)
            // stands in for a title; wordCount is 0 because the word-count/on-time metrics don't
            // apply to this event type (see the objectiveMetric-locking note in guild-event-card.jsx).
            await submitGuildEventSubmission(event.id, { title: pending.title || null, wordCount: 0, content: { worldPiece: pending.worldPiece } });
            setEditing(false);
            resetPicker();
            load();
        } catch (e) {
            setError(e.message || 'Could not submit your entry.');
        } finally {
            setBusy(false);
        }
    };

    const projectTitle = () => (project && project.title) || (projects || []).find((x) => x.id === selectedProjectId)?.title || 'Untitled project';

    const stageMap = (m) => setPending({
        title: m.title || null,
        worldPiece: {
            category: 'map', categoryLabel: CATEGORY_META.map.label,
            projectId: selectedProjectId, projectTitle: projectTitle(),
            mapId: m.id, mapTitle: m.title || null, imageUrl: m.imageUrl || null, pinCount: (m.pins || []).length,
        },
    });

    const stageHouse = (houseId) => {
        const houses = (project.world || []).filter((w) => w.category === 'houses');
        const house = houses.find((h) => h.id === houseId);
        if (!house) return;
        const graph = buildFamilyGraph(project.relationships || []);
        const stats = familyTreeStatsForHouse(house, project.characters || [], graph);
        setPending({
            title: house.topic || null,
            worldPiece: {
                category: 'familyTree', categoryLabel: CATEGORY_META.familyTree.label,
                projectId: selectedProjectId, projectTitle: projectTitle(),
                houseId: house.id, houseName: house.topic || null, crestUrl: house.crestUrl || null,
                memberCount: stats.memberCount, generationCount: stats.generationCount,
            },
        });
    };

    const stageLocation = (entry) => setPending({
        title: entry.name || null,
        worldPiece: {
            category: 'location', categoryLabel: CATEGORY_META.location.label,
            projectId: selectedProjectId, projectTitle: projectTitle(),
            locationId: entry.id, locationName: entry.name || null, region: entry.snippet || null,
        },
    });

    const handleSubmitRelationshipWeb = () => {
        const characters = (project.characters || []).map((c) => ({ id: c.id, name: c.name }));
        const houses = (project.world || []).filter((w) => w.category === 'houses').map((h) => ({ id: h.id, name: h.topic, crestUrl: h.crestUrl }));
        const autoEdges = extractCoMentionEdges(project.chapters || []);
        const manualEdges = project.relationships || [];
        setPending({
            title: null,
            worldPiece: {
                category: 'relationshipWeb', categoryLabel: CATEGORY_META.relationshipWeb.label,
                projectId: selectedProjectId, projectTitle: projectTitle(),
                characters, houses, autoEdges, manualEdges,
                characterCount: characters.length, relationshipCount: manualEdges.length,
            },
        });
    };

    // The line shown while the event is open; once it is completed EntrantResultStrip shows the entrant's own result instead.
    const activeNode = approvalStatus !== 'active' || submission === undefined ? null
        : submission
            ? React.createElement("div", { style: S.successNote }, '\u2713 Submitted')
            : React.createElement("div", { style: S.goldNote }, 'Not submitted yet');


    return React.createElement("div", { className: "ik-ev", style: S.divider },
        React.createElement("div", { style: S.fieldLabel }, 'Your entry'),

        config && React.createElement("div", { style: S.softHintLoose }, 'Judged blind by a panel of Inkroot judges, outside this guild. Word count doesn\u2019t apply here.'),

        React.createElement(EntrantResultStrip, { event, activeNode }),


        error && React.createElement("div", { style: S.errorText }, error),

        // ---------- Already submitted, not currently editing: read-only reveal ----------
        !pickerOpen && submission && submission.content && submission.content.worldPiece
            ? React.createElement("div", null,
                React.createElement(WorldPiecePreview, { worldPiece: submission.content.worldPiece }),
                approvalStatus === 'active' && React.createElement("button", { onClick: () => setEditing(true), style: { ...evTapBtn(false), marginTop: 8 } }, 'Choose a different piece'))

            // ---------- Picker ----------
            : pickerOpen && React.createElement("div", null,
                React.createElement(PickerSteps, {
                    step: pickerStep, onStep: goPickerStep,
                    detail: [selectedProjectId && projectTitle(), category && CATEGORY_META[category].label].filter(Boolean).join(' \u203a '),
                }),
                !selectedProjectId
                    ? React.createElement("div", null,
                        React.createElement("label", { style: S.capsLabel }, 'Which of your projects is this from?'),
                        projects === undefined && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textMuted } }, 'Loading your projects\u2026'),
                        projectsError && React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11] } }, projectsError),
                        projects && projects.length === 0 && React.createElement(EmptyState, { text: "You don't have any projects with a World Bible yet." }),
                        projects && projects.length > 0 && React.createElement("div", { style: S.col8 },
                            projects.map((p) => React.createElement("button", {
                                key: p.id, onClick: () => setSelectedProjectId(p.id),
                                style: wbChoiceStyle,
                            }, p.title || 'Untitled project'))))

                    : project === undefined
                        ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: C.textMuted } }, 'Opening this project\u2019s World Bible\u2026')
                        : project === null
                            ? React.createElement("div", { style: { color: C.danger, fontSize: TYPE_SCALE[11] } }, "Couldn't open that project.")
                            : React.createElement("div", null,
                                !category
                                    ? React.createElement("div", null,
                                        React.createElement("label", { style: S.capsLabel }, 'What are you submitting?'),
                                        React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8] } },
                                            Object.entries(CATEGORY_META).map(([key, meta]) => React.createElement("button", { key, onClick: () => setCategory(key), style: { ...evTapBtn(false, true), flex: '1 1 140px' } }, meta.label))))

                                    : !pending
                                        ? React.createElement("div", null,
                                            category === 'map' && (
                                                (project.maps || []).length === 0
                                                    ? React.createElement(EmptyState, { text: 'No maps in this project yet.' })
                                                    : React.createElement("div", { style: S.col8 },
                                                        (project.maps || []).map((m) => React.createElement("button", {
                                                            key: m.id, onClick: () => stageMap(m),
                                                            style: wbChoiceStyle,
                                                        }, `${m.title || 'Untitled map'} \u2014 ${(m.pins || []).length} pin${(m.pins || []).length === 1 ? '' : 's'}`)))),

                                            category === 'familyTree' && React.createElement(FamilyTreeGallery, {
                                                houses: (project.world || []).filter((w) => w.category === 'houses'),
                                                characters: project.characters || [], relationships: project.relationships || [],
                                                onOpenHouse: stageHouse, allCount: (project.world || []).filter((w) => w.category === 'houses').length,
                                            }),

                                            category === 'location' && React.createElement(WorldBibleBrowseList, {
                                                entries: worldBibleEntries(project, 'locations'), hasAnyBeforeSearch: false,
                                                onSelect: stageLocation, emptyText: 'No locations in this project yet.',
                                            }),

                                            category === 'relationshipWeb' && React.createElement("div", null,
                                                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginBottom: 8 } },
                                                    `${(project.characters || []).length} character${(project.characters || []).length === 1 ? '' : 's'} \u00b7 ${(project.relationships || []).length} relationship${(project.relationships || []).length === 1 ? '' : 's'}`),
                                                React.createElement("div", { style: { height: 'min(340px, 55vh)', border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], overflow: 'hidden', marginBottom: 10 } },
                                                    React.createElement(RelationshipWeb, {
                                                        characters: project.characters || [], autoEdges: extractCoMentionEdges(project.chapters || []),
                                                        manualEdges: project.relationships || [], houses: (project.world || []).filter((w) => w.category === 'houses'),
                                                        onSelectCharacter: () => {},
                                                    })),
                                                React.createElement("button", { disabled: busy, onClick: handleSubmitRelationshipWeb, style: { ...evTapBtn(true, true), width: '100%', opacity: busy ? 0.5 : 1 } },
                                                    busy ? '\u2026' : 'Review & submit')))

                                        // ---------- Confirm the staged (map/family-tree/location) selection ----------
                                        : React.createElement("div", null,
                                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: C.textSoft, marginBottom: 8 } }, `Submit this ${CATEGORY_META[pending.worldPiece.category].label.toLowerCase()}?`),
                                            React.createElement(WorldPiecePreview, { worldPiece: pending.worldPiece, compact: pending.worldPiece.category === 'relationshipWeb' }),
                                            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 10 } },
                                                React.createElement("button", { disabled: busy, onClick: handleSubmitPending, style: { ...evTapBtn(true, true), flex: 1, opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Submit entry'),
                                                React.createElement("button", { onClick: () => setPending(null), style: evTapBtn(false, true) }, 'Choose something else'))))));
}
