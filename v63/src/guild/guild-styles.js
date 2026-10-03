// Shared guild style fragments. These were repeated inline across the guild screens; each entry is the
// exact object it replaced, so nothing looks different. Spread to extend: style={{ ...S.note, marginTop: 8 }}.
import { C } from './guild-theme.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

export const S = Object.freeze({
    divider: { marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` },
    sectionLabel: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: C.textMuted, marginBottom: 10 },
    row8: { display: 'flex', gap: SPACE_SCALE[8] },
    row6: { display: 'flex', gap: SPACE_SCALE[6] },
    rowCenter8: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center' },
    rowBetween: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] },
    col8: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] },
    col10: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] },
    fill: { flex: 1, minWidth: 0 },
    note: { fontSize: TYPE_SCALE[11.5], color: C.textMuted },
    noteItalic: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, fontStyle: 'italic' },
    noteSmall: { fontSize: TYPE_SCALE[10.5], color: C.textMuted },
    noteCaption: { marginTop: 10, fontSize: TYPE_SCALE[10.5], color: C.textMuted, fontStyle: 'italic', textAlign: 'center' },
    emptyNote: { fontSize: TYPE_SCALE[11.5], color: C.textMuted, textAlign: 'center', padding: '10px 0' },
    emptyBlock: { textAlign: 'center', color: C.textMuted, fontSize: TYPE_SCALE[12], padding: '20px 0' },
    loadingBlock: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: C.textMuted },
    fieldLabel: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: C.textSoft, marginBottom: 8 },
    errorText: { color: C.danger, fontSize: TYPE_SCALE[11], marginBottom: 8 },
    successText: { fontSize: TYPE_SCALE[11], color: C.success },
    successNote: { fontSize: TYPE_SCALE[11.5], color: C.success },
    goldNote: { fontSize: TYPE_SCALE[11.5], color: C.gold },
    goldNoteBold: { fontSize: TYPE_SCALE[11.5], color: C.goldBright, fontWeight: 600 },
    infoNote: { fontSize: TYPE_SCALE[11.5], color: C.info },
    softHint: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginBottom: 8 },
    softHintLoose: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, marginBottom: 10 },
    serifTitle: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: C.text },
    // Small uppercase caption above a form field / section (was copied as evLabelStyle, qzLabelStyle and tnLabelStyle).
    capsLabel: { fontSize: TYPE_SCALE[10.5], color: C.textSoft, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' },
    // The one card used inside event panels (quiz, tournament, world-building all read this).
    card: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[12], padding: 14 },
    insetPanel: { background: C.panel, border: `1px solid ${C.border}`, borderRadius: RADIUS_SCALE[8], padding: 10 },
});

// Serif face used for headlines and big numbers on the Guild's quiz and tournament screens.
export const SERIF = "'Fraunces', Georgia, serif";

// Visually hidden but read by screen readers.
export const srOnly = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0 };

// Small tinted status pill. padX is the horizontal padding (the quiz screens use 9, the tournament screens 10).
export const pillStyle = (color, padX = 10) => ({
    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], padding: `2px ${padX}px`, borderRadius: RADIUS_SCALE[100],
    fontSize: TYPE_SCALE[10.5], color, background: `${color}1A`, border: `1px solid ${color}55`, textTransform: 'uppercase', letterSpacing: '0.05em',
});
