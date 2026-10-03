// ---------- DOCX export ----------
// Mirrors buildManuscriptPdf() in pdf-export.js — a title "page", then each chapter starting on
// its own page — but via the `docx` package instead of hand-drawn PDF text, entirely on-device
// (Packer.toBlob runs in the browser, no server round-trip, same "no upload anywhere" policy as
// every other export path in this file).
//
// Same simplification PDF export already makes: a chapter's stored HTML is flattened to plain
// paragraphs via stripHtml (the same helper buildManuscriptText/buildManuscriptPdf both already
// use), so inline bold/italic runs aren't preserved. Word is the one export format where readers
// would actually expect to keep editing/reformatting the text afterward, so preserving structure
// (real paragraph breaks, a real heading style per chapter, a real page break between chapters)
// matters more here than it does for PDF — that's what this keeps, just not inline emphasis.
import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import { stripHtmlToPlain } from '../shared-utils/strip-html.jsx';
import { hasRtl, isValidLanguageCode } from './text-script.js';

// Splits a chapter's plain text into paragraphs (blank-line separated) — identical rule to
// pdf-export.js's own paragraphsOf, kept as its own small copy rather than a shared import so
// each export module stays a self-contained, independently-loadable chunk (see the dynamic
// import in ExportWorkPanel below).
function paragraphsOf(plainText) {
    return plainText.split(/\n{2,}|\n/).map((p) => p.trim());
}

// Returns a Blob (the .docx file itself) — Packer.toBlob already hands back a browser Blob
// directly, so there's no intermediate bytes step the way pdf-lib's pdfDoc.save() needs.
export async function buildManuscriptDocx(project) {
    const children = [];

    if (project.title) {
        children.push(new Paragraph({
            children: [new TextRun({ text: project.title, bold: true })],
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }));
    }
    if (project.author) {
        children.push(new Paragraph({
            children: [new TextRun({ text: `by ${project.author}`, italics: true })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
        }));
    }

    const chapters = (project.chapters || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
    chapters.forEach((ch) => {
        const headingText = ch.title || `Chapter ${ch.number || ''}`;
        const headingRtl = hasRtl(headingText);
        children.push(new Paragraph({
            children: [new TextRun({ text: headingText, bold: true, ...(headingRtl ? { rightToLeft: true } : {}) })],
            ...(headingRtl ? { bidirectional: true } : {}),
            heading: HeadingLevel.HEADING_1,
            pageBreakBefore: true,
            spacing: { after: 240 },
        }));
        const bodyText = stripHtmlToPlain(ch.text).trim();
        paragraphsOf(bodyText).forEach((para) => {
            // Arabic/Hebrew paragraphs are flagged right-to-left so Word lays them out (and aligns
            // them) correctly; everything else is exactly what it was.
            const rtl = para && hasRtl(para);
            children.push(new Paragraph({
                children: para ? [rtl ? new TextRun({ text: para, rightToLeft: true }) : new TextRun(para)] : [],
                ...(rtl ? { bidirectional: true } : {}),
                spacing: { after: 200 },
            }));
        });
    });

    const doc = new Document({
        creator: 'Inkroot',
        title: project.title || 'Untitled Manuscript',
        // Only when the author picked a book language in Settings; left alone it behaves as before.
        // Sets Word's proofing language so a Yoruba/French/etc. book isn't marked as misspelt English.
        ...(isValidLanguageCode(project.language) ? { styles: { default: { document: { run: { language: { value: project.language } } } } } } : {}),
        sections: [{ children }],
    });
    return Packer.toBlob(doc);
}
