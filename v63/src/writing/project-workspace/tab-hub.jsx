import React from 'react';
import { ArchiveSectionHeading } from '../../shared-ui/ui-cards.jsx';
import { InkIcon } from '../../shell/ink-icon.jsx';
import { NavScrollBox, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { NAV_GROUPS } from '../../shell/nav-labels.jsx';

// Extracted from the monolithic project-workspace.jsx `tab === 'hub'` block, unchanged in
// behavior — only the state it read is now passed in as props instead of closed over.
export function HubTab({
    projectId, project, chapters, totalHealthIssues, streak, totalWords,
    achievements, unlockedAchievementCount, setTab, setWorldCategory,
}) {
    return React.createElement(NavScrollBox, { navKey: `ws-${projectId}-hub`, style: { flex: 1, padding: '48px 40px 64px', overflowY: 'auto', display: 'flex', justifyContent: 'center' }, className: "scrollbox tab-fade" },
        React.createElement("div", { style: { width: '100%', maxWidth: 560 } },
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Archive"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8A8A92', marginTop: 6, letterSpacing: '0.04em' } }, project.title || 'Untitled Novel')),
            // Fix-list item 3: one primary "Continue Manuscript" action card, so every project
            // screen has a clear Level-1 action instead of an 18-row list where Manuscript reads
            // the same as Glossary or Achievements. Same gold/walnut card language the rest of
            // this screen already uses (ArchiveSectionHeading, the row hovers below) — not the
            // Home hero's cover/page/glow "desk scene" treatment, which is a heavier pattern than
            // a single already-open project needs. The Manuscript row further down (Story group)
            // stays as-is, same as Home's own featured project still appearing in its regular
            // list — this card doesn't replace it, just fronts it.
            React.createElement("div", {
                onClick: () => setTab('manuscript'), className: "archive-primary-card", style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[16],
                    cursor: 'pointer', padding: '20px 22px', borderRadius: RADIUS_SCALE[14], marginBottom: 40,
                    background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 18px rgba(0,0,0,0.35)',
                } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[16], minWidth: 0 } },
                    React.createElement("span", { style: {
                            display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, flexShrink: 0,
                            borderRadius: RADIUS_SCALE[10], background: 'rgba(232,196,104,0.12)', border: '1px solid rgba(232,196,104,0.3)',
                        } }, React.createElement(InkIcon, { name: "book", size: 22, color: "#E8C468" })),
                    React.createElement("div", { style: { minWidth: 0 } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], fontWeight: 600, color: '#EFE7D2' } }, "Continue Manuscript"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#9C9280', marginTop: 3, fontStyle: 'italic' } }, `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`)))),
            (() => {
                const subtitleFor = (item) => {
                    if (item.key === 'manuscript')
                        return `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`;
                    if (item.key === 'notes')
                        return `${project.notes.length} note${project.notes.length === 1 ? '' : 's'}`;
                    if (item.key === 'locations')
                        return `${project.locations.length} place${project.locations.length === 1 ? '' : 's'}`;
                    if (item.key === 'maps')
                        return `${project.maps.length} map${project.maps.length === 1 ? '' : 's'}`;
                    if (item.key === 'timeline')
                        return `${project.timeline.length} event${project.timeline.length === 1 ? '' : 's'}`;
                    if (item.key === 'glossary')
                        return `${project.glossary.length} term${project.glossary.length === 1 ? '' : 's'}`;
                    if (item.key === 'characters')
                        return `${project.characters.length} in your cast`;
                    if (item.key === 'health')
                        return totalHealthIssues > 0 ? `${totalHealthIssues} thing${totalHealthIssues === 1 ? '' : 's'} to check` : 'All clear';
                    if (item.key === 'progress')
                        return streak > 0 ? `${streak}-day streak` : `${totalWords.toLocaleString()} words`;
                    if (item.key === 'achievements')
                        return `${unlockedAchievementCount} of ${achievements.length} unlocked`;
                    if (item.key === 'settings')
                        return 'title, backup, delete';
                    if (item.key === 'packs')
                        return `${project.worldbuildingPacks.length} pack${project.worldbuildingPacks.length === 1 ? '' : 's'}`;
                    if (item.key === 'world' && item.worldCategory) {
                        const count = project.world.filter((w) => w.category === item.worldCategory).length;
                        return `${count} entr${count === 1 ? 'y' : 'ies'}`;
                    }
                    return `${project.world.length} entr${project.world.length === 1 ? 'y' : 'ies'}`;
                };
                return NAV_GROUPS.map((group, gIdx) => React.createElement("div", { key: group.key, className: "archive-section-in", style: { marginBottom: 46, '--i': gIdx } },
                    React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: group.icon, size: 20, style: { display: "inline-block" } }), label: group.label }),
                    // Demoted from a bordered/filled card per row to a plain list row (fix-list
                    // item 3) now that Continue Manuscript above is the one Level-1 action —
                    // border kept as 1px transparent (not `none`) so the existing archive-row
                    // hover rule in project-workspace.jsx, which sets border-color, still shows.
                    React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[2], marginTop: 18 } }, group.items.map((item, idx) => React.createElement("div", { key: `${item.key}-${item.worldCategory || idx}`, onClick: () => { setTab(item.key); if (item.worldCategory)
                            setWorldCategory(item.worldCategory); }, className: "archive-row", style: {
                            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], cursor: 'pointer',
                            padding: '10px 8px', borderRadius: RADIUS_SCALE[9], background: 'transparent', border: '1px solid transparent',
                        } },
                        React.createElement("span", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, flexShrink: 0 } }, React.createElement(InkIcon, { name: item.icon, size: 16, color: "#8A8272" })),
                        React.createElement("div", { style: { flex: 1 } },
                            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 500, color: '#D9D2BE' } }, item.label),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#6E6A63', marginTop: 1, fontStyle: 'italic' } }, subtitleFor(item))),
                        React.createElement("span", { className: "archive-row-arrow", style: { color: '#84848C' } }, "\u203A"))))));
            })()));
}
