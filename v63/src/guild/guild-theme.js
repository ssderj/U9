// Guild colour tokens. One place to change the Guild's look; every guild screen reads from here.
// Values are the exact hex strings the screens used before, so swapping a token changes every use of it
// at once and nothing changes visually until you edit a value here.
export const C = Object.freeze({
    // text
    textStrong: '#F4EEDD',
    text: '#EFE7D2',
    textBright: '#D9D2BE',
    textDim: '#B5B0A5',
    textSoft: '#A39C8C',
    textMuted: '#948D7E',
    parchment: '#C9BE8D',
    // neutrals (warm greys used for disabled / secondary UI; were cool blue-greys)
    neutral: '#8E8878',
    neutralSoft: '#948D7E',
    neutralMid: '#837C6D',
    neutralDim: '#5F5849',
    // gold accents
    goldBright: '#E8C468',
    goldPale: '#F2CE7A',
    gold: '#C89B3C',
    // status / accents
    success: '#8FCB8F',
    danger: '#D98A8A',
    copper: '#B8735C',
    copperLight: '#C97B63',
    info: '#8FB8CB',
    sky: '#7FB2C9',
    brown: '#3B2A18',
    // surfaces (dark to light)
    inputBg: '#100E0A',
    panel: '#181510',
    surfaceDeep: '#17140F',
    surfaceInk: '#17130E',
    surfaceAlt: '#1A160D',
    surface: '#1C1810',
    surfaceMuted: '#1D1A14',
    surfaceWarm: '#211C13',
    surfaceRaised: '#241F14',
    // medal + event-type tints (were hard-coded hex in the quiz, tournament and event screens)
    medalSilver: '#C7CCD6',
    medalBronze: '#B08D57',
    typeTournament: '#A08FD6', // violet: was gold, which read as the 'pending approval' status
    typeGiveaway: '#C97FB0',
    typeWorkshop: '#A8B56C', // olive: was ochre, too close to gold and to the tournament tint
    typeQuiz: '#5FBDB4', // teal: was the same blue as the 'approved / published' status
    // event poster card surfaces
    posterTop: '#201C15',
    posterBottom: '#1C1912',
    statBorder: '#2A2418',
    // official-notice surfaces and accents (the event poster, ticket stub and events list banner)
    noticeTop: '#211D14',
    noticeDeep: '#18150F',
    noticeStub: '#1B1811',
    noticeNotch: '#17171B',
    noticeBannerTop: '#201A19',
    formTop: '#1F1B1A',
    ribbonTop: '#F2D98A',
    phaseActive: '#8FA37A',
    goldMuted: '#B5A87A',
    ledgerLine: '#2A2418',
    ledgerArrow: '#5A4F38',
    // borders
    border: '#3A3020',
    borderStrong: '#4A3D22',
});

// Translucent versions of the accent colours: goldA(0.4) is goldBright at 40% opacity, and so on.
const rgbaOf = (r, g, b) => (a) => `rgba(${r},${g},${b},${a})`;
export const goldA = rgbaOf(232, 196, 104);   // C.goldBright
export const successA = rgbaOf(143, 203, 143); // C.success
export const dangerA = rgbaOf(217, 138, 138);  // C.danger
export const infoA = rgbaOf(143, 184, 203);    // C.info
export const amberA = rgbaOf(200, 155, 60);    // C.gold

// One rule for "time is running out", used by the quiz clock and the tournament countdown: neutral, then copper,
// then red. Thresholds are in seconds; the quiz uses the defaults, the tournament passes hour-sized ones.
export function urgencyColor(secondsLeft, { copper = 30, danger = 10 } = {}) {
    if (secondsLeft == null || Number.isNaN(secondsLeft)) return C.textBright;
    if (secondsLeft <= danger) return C.danger;
    if (secondsLeft <= copper) return C.copperLight;
    return C.textBright;
}
