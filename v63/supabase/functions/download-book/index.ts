// Generates a downloadable PDF or EPUB for a published book, entirely server-side. This is the
// one place a reader's copy of a book's full text is ever handed out as a file rather than
// streamed into the in-app reader (see lib/library.js's checkBookReadAccess/
// fetchPublishedBookContent for the normal read path) — every check that path already makes is
// re-checked here too, plus one more: the author has to have opted this specific book into
// downloads (published_books.downloadable), a flag that's only ever settable at publish time and
// locked immutable after (see the migration's lock_downloadable_after_insert() trigger — the only
// way an author changes their mind is to unpublish and publish again).
//
// Deliberately generated here rather than trusted from the client: a client-side "build the PDF
// from whatever fetchPublishedBookContent returned" button would be no safer than reading the
// book in-app already is (the full text is already in the page once it renders), so it would add
// UI without adding any real protection. Doing it here at least means the file only ever leaves
// Inkroot's own server after re-checking access and the author's own opt-in, not on the strength
// of whatever a modified client claims.
//
// No watermarking or DRM — an intentional scope decision, not an oversight. A real watermark
// (buyer name/email baked into the file) is the natural next step if this needs to trace a leaked
// copy back to whoever downloaded it; this first pass only gates who can get a file at all.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { PDFDocument, rgb } from 'npm:pdf-lib@1.17.1';
import fontkit from 'npm:@pdf-lib/fontkit@1.1.1';
import JSZip from 'npm:jszip@3.10.1';
// Same-folder module (not a cross-function import), so it deploys with this function. See its
// header for exactly what it covers and how to regenerate it.
import { DEJAVU_SERIF_REGULAR_B64, DEJAVU_SERIF_BOLD_B64 } from './dejavu-serif-fonts.ts';

// Inlined rather than imported from a shared file: this function is deployed independently
// and the deploy path used doesn't reliably resolve cross-function relative imports.
function sanitizeError(e: any, fallback = 'Something went wrong. Please try again.'): string {
  console.error('Inkroot function error:', e);
  if (!e || typeof e.message !== 'string' || !e.message) return fallback;
  if (e.code === 'P0001') return e.message; // our own raise exception '...'
  // A named SDK error class (PostgrestError, AuthApiError, StorageApiError, FunctionsHttpError,
  // a raw JS runtime error) is backend/SDK detail, not something we wrote -- hide it. A plain
  // `new Error('...')` keeps JS's own default 'Error' name even after code elsewhere adds extra
  // properties to it (e.g. a custom .code), so this is a more reliable signal than .code alone,
  // which doesn't catch Storage/Auth errors the way it catches Postgrest ones. See
  // src/lib/errors.js's client-side twin for the full reasoning.
  const name = typeof e.name === 'string' ? e.name : '';
  if (name && name !== 'Error') return fallback;
  // Defensive fallback for a Postgrest-shaped object with no .name at all -- still catch it by
  // the presence of a .code, same as the original check did.
  const hasCode = typeof e.code === 'string' && e.code.length > 0;
  if (!name && hasCode) return fallback;
  return e.message; // our own throw new Error('...')
}


const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Without this the browser hides Content-Disposition from the cross-origin fetch in
  // lib/library.js, so the file name chosen here was never readable and every download was saved as
  // "book.pdf" / "book.epub".
  'Access-Control-Expose-Headers': 'Content-Disposition',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Header values must be ASCII, so a title in Yoruba/Greek/Russian/etc. is sent two ways (RFC 6266):
// filename="..." is an accent-stripped ASCII fallback, filename*=UTF-8''... carries the real name,
// percent-encoded. lib/library.js reads filename* first and falls back to the plain one.
function fileResponse(bytes: Uint8Array, filename: string, mimeType: string): Response {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  const asciiStem = stem.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\-_ ]/gi, '').trim() || 'book';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return new Response(bytes, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${asciiStem}${ext}"; filename*=UTF-8''${encoded}`,
    },
  });
}

function callerClient(req: Request) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
  );
}

function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

// Turns one chapter's stored HTML into plain paragraphs — good enough for a clean read, and (for
// the EPUB path especially) guarantees well-formed output regardless of whatever HTML the editor
// produced, rather than re-embedding untrusted/possibly-not-strictly-valid markup as XHTML.
function htmlToParagraphs(html: string): string[] {
  if (!html) return [];
  const withBreaks = String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const decoded = withBreaks
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return decoded
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// Best-effort <dc:language> from the script of the text. Inline copy of guessBookLanguage in
// src/writing/text-script.js (Edge Functions deploy independently) -- keep the two in step. A script
// used by several languages gets "und" (undetermined); Latin stays "en" because French, Yoruba and
// English can't be told apart by script.
function guessBookLanguage(sample: string): string {
  const s = String(sample || '').slice(0, 6000);
  const n = (re: RegExp) => (s.match(re) || []).length;
  const latin = n(/\p{Script=Latin}/gu);
  const kana = n(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const han = n(/\p{Script=Han}/gu);
  const scripts: Array<[string, number]> = [
    ['el', n(/\p{Script=Greek}/gu)],
    ['he', n(/\p{Script=Hebrew}/gu)],
    ['th', n(/\p{Script=Thai}/gu)],
    ['ko', n(/\p{Script=Hangul}/gu)],
    ['bn', n(/\p{Script=Bengali}/gu)],
    ['und', n(/[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Ethiopic}]/gu)],
  ];
  if (kana > 0 && kana + han > latin) return 'ja';
  if (han > latin && han >= Math.max(...scripts.map((x) => x[1]))) return 'zh';
  let best: [string, number] = ['en', latin];
  for (const sc of scripts) if (sc[1] > best[1]) best = sc;
  return best[0];
}

function xmlEscape(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------- PDF ----------
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BODY_SIZE = 11.5;
const LINE_HEIGHT = 17;

function wrapLine(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// The PDF used to be set in pdf-lib's built-in Times, which only encodes Windows-1252 (WinAnsi):
// Yoruba/Igbo/Hausa letters, Vietnamese, Turkish and Polish letters, Greek, Cyrillic and every
// other script were stripped or became '?' (and before makePdfSafe existed they made the whole
// download throw). It now embeds DejaVu Serif (see dejavu-serif-fonts.ts), which draws all of
// those. makePdfSafe is kept as the fallback for what DejaVu still can't draw -- Arabic, Hebrew,
// Indic scripts, Thai, CJK, emoji: a few symbols get a text equivalent, accents are dropped from
// a letter the font lacks, anything else becomes '?'. The EPUB path is UTF-8 and never needed this.
const PDF_SYMBOL_FALLBACKS: Record<string, string> = {
  '\u20A6': 'N', '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u2713': 'v', '\u2022': '*',
  '\u00A0': ' ', '\u2009': ' ', '\u202F': ' ', '\u2007': ' ',
  '\u2605': '*', '\u2606': '*',
};
function makePdfSafe(font: any): (text: string) => string {
  const supported = new Set<number>(font.getCharacterSet());
  const encodable = (s: string) => Array.from(s).every((c) => supported.has(c.codePointAt(0)!));
  return (text: string): string => {
    let out = '';
    for (const ch of String(text ?? '').normalize('NFC')) {
      const cp = ch.codePointAt(0)!;
      if (supported.has(cp)) { out += ch; continue; }
      // zero-width characters, plus the emoji/text variation selectors that trail an emoji or symbol
      // (dropping them stops one unsupported emoji from printing as two or three '?')
      if (cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF || cp === 0xFE0E || cp === 0xFE0F) continue;
      if (PDF_SYMBOL_FALLBACKS[ch] !== undefined) { out += PDF_SYMBOL_FALLBACKS[ch]; continue; }
      const stripped = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      if (stripped === '') continue; // a lone combining mark (leftover tone accent) is dropped
      out += encodable(stripped) ? stripped : '?';
    }
    return out;
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function buildPdf(title: string, author: string, chapters: Array<{ title?: string; text?: string }>): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  // subset: true embeds only the glyphs the book actually uses, so the file stays small.
  const bodyFont = await pdf.embedFont(base64ToBytes(DEJAVU_SERIF_REGULAR_B64), { subset: true });
  const boldFont = await pdf.embedFont(base64ToBytes(DEJAVU_SERIF_BOLD_B64), { subset: true });
  // Regular and Bold are cut from the same ranges, so one sanitizer (built from Regular) covers both.
  const safe = makePdfSafe(bodyFont);
  title = safe(title);
  author = safe(author);

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };
  const ensureRoom = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };
  const drawWrapped = (text: string, font: any, size: number, lineHeight: number) => {
    for (const line of wrapLine(text, font, size, CONTENT_WIDTH)) {
      ensureRoom(lineHeight);
      page.drawText(line, { x: MARGIN, y, size, font, color: rgb(0.1, 0.1, 0.1) });
      y -= lineHeight;
    }
  };

  // Title page
  y = PAGE_HEIGHT / 2 + 60;
  for (const line of wrapLine(title || 'Untitled', boldFont, 26, CONTENT_WIDTH)) {
    const w = boldFont.widthOfTextAtSize(line, 26);
    page.drawText(line, { x: (PAGE_WIDTH - w) / 2, y, size: 26, font: boldFont, color: rgb(0, 0, 0) });
    y -= 34;
  }
  y -= 20;
  if (author) {
    const w = bodyFont.widthOfTextAtSize(author, 14);
    page.drawText(author, { x: (PAGE_WIDTH - w) / 2, y, size: 14, font: bodyFont, color: rgb(0.3, 0.3, 0.3) });
  }

  for (const chapter of chapters) {
    newPage();
    drawWrapped(safe(chapter.title || 'Untitled Chapter'), boldFont, 18, 24);
    y -= 10;
    for (const para of htmlToParagraphs(chapter.text || '')) {
      drawWrapped(safe(para), bodyFont, BODY_SIZE, LINE_HEIGHT);
      y -= 8; // paragraph spacing
    }
  }

  return pdf.save();
}

// ---------- EPUB ----------
async function buildEpub(title: string, author: string, chapters: Array<{ title?: string; text?: string }>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const bookId = crypto.randomUUID();
  const chapterFiles = chapters.map((ch, i) => ({
    id: `chapter${i + 1}`,
    filename: `chapter${i + 1}.xhtml`,
    title: ch.title || `Chapter ${i + 1}`,
    paragraphs: htmlToParagraphs(ch.text || ''),
  }));

  for (const ch of chapterFiles) {
    const body = ch.paragraphs.map((p) => `<p>${xmlEscape(p)}</p>`).join('\n    ');
    zip.file(`OEBPS/${ch.filename}`, `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${xmlEscape(ch.title)}</title></head>
<body>
  <h1>${xmlEscape(ch.title)}</h1>
  ${body}
</body>
</html>`);
  }

  const manifestItems = chapterFiles
    .map((ch) => `<item id="${ch.id}" href="${ch.filename}" media-type="application/xhtml+xml"/>`)
    .join('\n    ');
  const spineItems = chapterFiles.map((ch) => `<itemref idref="${ch.id}"/>`).join('\n    ');
  const navPoints = chapterFiles
    .map((ch, i) => `<navPoint id="navpoint-${i + 1}" playOrder="${i + 1}"><navLabel><text>${xmlEscape(ch.title)}</text></navLabel><content src="${ch.filename}"/></navPoint>`)
    .join('\n    ');

  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${xmlEscape(title)}</dc:title>
    <dc:creator>${xmlEscape(author || 'Unknown')}</dc:creator>
    <dc:language>${xmlEscape(guessBookLanguage([title, ...chapterFiles.slice(0, 3).map((c) => c.paragraphs.join(' ').slice(0, 1500))].join(' ')))}</dc:language>
    <dc:identifier id="BookId">urn:uuid:${bookId}</dc:identifier>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`);

  zip.file('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:${bookId}"/>
  </head>
  <docTitle><text>${xmlEscape(title)}</text></docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`);

  return zip.generateAsync({ type: 'uint8array' });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  try {
    const client = callerClient(req);
    const { data: authData, error: authErr } = await client.auth.getUser();
    if (authErr || !authData.user) throw new Error('Not signed in');
    const user = authData.user;

    // No prior cap existed here at all — a signed-in account could loop this indefinitely
    // against any free/downloadable book, each call doing real server-side PDF/EPUB generation.
    // 20 downloads/hour comfortably covers a real reader building a library while blocking a
    // scripted loop.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'download_book',
    });
    // Throw the error itself, not a re-wrapped plain Error: sanitizeError shows P0001 (our own
    // 'too many requests' raise) but hides anything else (PostgREST/network detail).
    if (rlErr) throw rlErr;

    const { bookId, format } = await req.json();
    if (!bookId || !['pdf', 'epub'].includes(format)) throw new Error('Invalid request');

    const db = serviceClient();
    const { data: book, error: bookErr } = await db
      .from('published_books')
      .select('id, author_id, price, downloadable, title, destination, removed_by_moderator')
      .eq('id', bookId)
      .maybeSingle();
    if (bookErr || !book) throw new Error('Book not found');
    // This function runs as the service role, so published_books' RLS (which hides a
    // moderator-removed book from everyone but its author) doesn't apply here — without this
    // check a takedown removed the listing but the file stayed downloadable by anyone with the id.
    if (book.removed_by_moderator && book.author_id !== user.id) throw new Error('Book not found');

    if (!book.downloadable) throw new Error("The author hasn't made this book available for download");

    const isAuthor = book.author_id === user.id;
    let allowed = isAuthor;

    if (!allowed && book.destination === 'unlisted') {
      // Migration 118: an unpublished book that already had paying readers is kept (hidden from
      // every public surface) so those readers keep what they paid for. Only a past buyer may
      // download it — the free-book shortcut below must not apply to it, and anyone else gets the
      // same answer as for a book that doesn't exist.
      const { data: purchase } = await db
        .from('purchases')
        .select('id')
        .eq('book_id', bookId)
        .eq('buyer_id', user.id)
        .eq('kind', 'book')
        .eq('status', 'success')
        .limit(1)
        .maybeSingle();
      allowed = !!purchase;
      if (!allowed) throw new Error('Book not found');
    } else if (!allowed && book.destination === 'guild') {
      // Guild-book model, resolved (audit finding: this file and paystack-init-purchase used to
      // describe two different models): a guild-destination book is MEMBERSHIP-gated, never
      // purchase-gated — a member downloads it without any `purchases` row, and price is ignored
      // (Guild-only listings aren't sold in the Grand Library). This is the same rule reading
      // follows (published_book_content's read policies, migrations 90/92; lib/library.js's
      // checkBookReadAccess treats a guild book as price 0), and paystack-init-purchase now
      // refuses kind='book' for a guild book so a member can't pay for something this check
      // already gives them; kind='tip' is still allowed there.
      //
      // Membership is checked here explicitly because this function runs as the service role
      // (bypasses RLS entirely): without it a signed-in non-member could download a Guild's
      // exclusive book the same as any Grand Library one, defeating the whole point of
      // publishing to a Guild instead.
      const { data: isMember } = await db.rpc('is_guild_book_member', {
        p_book_id: bookId,
        p_user_id: user.id,
      });
      allowed = !!isMember;
      if (!allowed) throw new Error("You're not a member of this book's Guild");
    } else if (!allowed) {
      const isFree = !book.price || book.price <= 0;
      allowed = isFree;
      if (!allowed) {
        const { data: purchase } = await db
          .from('purchases')
          .select('id')
          .eq('book_id', bookId)
          .eq('buyer_id', user.id)
          .eq('status', 'success')
          .limit(1)
          .maybeSingle();
        allowed = !!purchase;
      }
      if (!allowed) throw new Error("You haven't purchased this book");
    }

    const { data: contentRow, error: contentErr } = await db
      .from('published_book_content')
      .select('content')
      .eq('book_id', bookId)
      .maybeSingle();
    if (contentErr || !contentRow) throw new Error('Book content not found');

    const content = contentRow.content || {};
    const title = content.title || book.title || 'Untitled';
    const author = content.author || '';
    const chapters = Array.isArray(content.chapters) ? content.chapters : [];

    // Keep letters and digits from every script (not just a-z), drop anything a file system or the
    // header rules dislike, and cut by code point so an emoji is never split in half.
    const safeName = Array.from(title.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\-_ ]/gu, '').trim()).slice(0, 80).join('').trim() || 'book';

    if (format === 'pdf') {
      const bytes = await buildPdf(title, author, chapters);
      return fileResponse(bytes, `${safeName}.pdf`, 'application/pdf');
    } else {
      const bytes = await buildEpub(title, author, chapters);
      return fileResponse(bytes, `${safeName}.epub`, 'application/epub+zip');
    }
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
