// Small script helpers for the export paths (EPUB language tag, Word right-to-left flag).
// No dependencies; pure functions over a string. The server's download-book function carries its own
// inline copy of guessBookLanguage (Edge Functions deploy independently) -- keep the two in step.

// Hebrew, Arabic, Syriac, Thaana, N'Ko and the Arabic presentation forms.
const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
export function hasRtl(text) {
    return RTL_RE.test(text || '');
}

const count = (s, re) => (s.match(re) || []).length;

// Best-effort BCP-47 tag for an EPUB's <dc:language>. Inkroot has no per-book language field, so
// this looks at the script. A script that maps to one language gets that code (Greek el, Hebrew he,
// Thai th, Korean ko, Japanese ja, Chinese zh, Bengali bn). A script shared by several languages
// (Cyrillic, Arabic, Devanagari, Ethiopic) gets "und" -- the valid "undetermined" tag -- rather than a
// confident wrong guess. Latin script stays "en" as it always was: French, Yoruba, Hausa and English
// are indistinguishable by script, so a real fix there needs a language field on the project.
export function guessBookLanguage(sample) {
    const s = String(sample || '').slice(0, 6000);
    const latin = count(s, /\p{Script=Latin}/gu);
    const kana = count(s, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
    const han = count(s, /\p{Script=Han}/gu);
    const scripts = [
        ['el', count(s, /\p{Script=Greek}/gu)],
        ['he', count(s, /\p{Script=Hebrew}/gu)],
        ['th', count(s, /\p{Script=Thai}/gu)],
        ['ko', count(s, /\p{Script=Hangul}/gu)],
        ['bn', count(s, /\p{Script=Bengali}/gu)],
        ['und', count(s, /[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Ethiopic}]/gu)],
    ];
    if (kana > 0 && kana + han > latin) return 'ja';
    if (han > latin && han >= Math.max(...scripts.map((x) => x[1]))) return 'zh';
    let best = ['en', latin];
    for (const sc of scripts) if (sc[1] > best[1]) best = sc;
    return best[0];
}

// ---------- Per-book language (Settings -> Book language) ----------
// project.language is '' (automatic) or one of these codes. Script detection above cannot tell Latin-
// script languages apart, so a Yoruba, Hausa or French book was always tagged "en"; an explicit choice
// fixes that. The same code feeds the EPUB <dc:language> and Word's proofing language (so Word stops
// red-underlining a whole Yoruba chapter as misspelt English).
export const BOOK_LANGUAGES = [
    ['en', 'English'], ['yo', 'Yor\u00f9b\u00e1'], ['ig', 'Igbo'], ['ha', 'Hausa'], ['pcm', 'Nigerian Pidgin'],
    ['fr', 'Fran\u00e7ais (French)'], ['es', 'Espa\u00f1ol (Spanish)'], ['pt', 'Portugu\u00eas (Portuguese)'],
    ['de', 'Deutsch (German)'], ['it', 'Italiano (Italian)'], ['nl', 'Nederlands (Dutch)'], ['sw', 'Kiswahili (Swahili)'],
    ['zu', 'isiZulu (Zulu)'], ['am', 'Amharic'], ['tr', 'T\u00fcrk\u00e7e (Turkish)'], ['pl', 'Polski (Polish)'],
    ['vi', 'Ti\u1ebfng Vi\u1ec7t (Vietnamese)'], ['id', 'Bahasa Indonesia'], ['ru', 'Russian'], ['uk', 'Ukrainian'],
    ['el', 'Greek'], ['ar', 'Arabic'], ['he', 'Hebrew'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['th', 'Thai'],
    ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
];

const LANG_CODE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
export function isValidLanguageCode(code) {
    return typeof code === 'string' && LANG_CODE_RE.test(code);
}

// The language to write into an export: the author's explicit choice if there is one, otherwise the
// script-based guess (which still returns "en" for Latin script, exactly as before).
export function resolveBookLanguage(project, sample) {
    const chosen = project && project.language;
    return isValidLanguageCode(chosen) ? chosen : guessBookLanguage(sample);
}
