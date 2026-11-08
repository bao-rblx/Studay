// Dependency-free text extraction for uploaded study material.
// Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) are ZIP archives of XML parts, so a small
// reader on top of node:zlib is enough - no new npm dependency, and the digits stay readable.
// PDFs and images are deliberately not parsed here: the AI vision path already reads those.
const zlib = require('node:zlib');

const MAX_BYTES = 20 * 1024 * 1024; // largest upload we agree to open
const MAX_TEXT = 200000; // matches the materials column, so nothing is silently cut later
const MAX_INFLATE = 40 * 1024 * 1024; // zip-bomb floor: a real document never inflates this far

const SIG = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 };
const ZIP64_MARK = 0xffffffff;
const FLAG_ENCRYPTED = 0x1;

const EXT_KIND = {
  '.txt': 'text', '.md': 'text', '.markdown': 'text', '.csv': 'text', '.json': 'text',
  '.docx': 'docx', '.pptx': 'pptx', '.xlsx': 'xlsx',
  '.pdf': 'binary', '.png': 'binary', '.jpg': 'binary', '.jpeg': 'binary', '.webp': 'binary',
  '.heic': 'binary',
};
const OFFICE_MIME = 'application/vnd.openxmlformats-officedocument';
const MIME_KIND = {
  [`${OFFICE_MIME}.wordprocessingml.document`]: 'docx',
  [`${OFFICE_MIME}.presentationml.presentation`]: 'pptx',
  [`${OFFICE_MIME}.spreadsheetml.sheet`]: 'xlsx',
  'application/pdf': 'binary',
  'image/png': 'binary', 'image/jpeg': 'binary', 'image/webp': 'binary', 'image/heic': 'binary',
};
const SUPPORTED_EXTENSIONS = Object.keys(EXT_KIND);

// Error codes the API layer maps to HTTP statuses: UNSUPPORTED, TOO_LARGE, BAD_ZIP, EMPTY.
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const extensionOf = (name) => {
  const base = String(name || '').trim().toLowerCase().split(/[\\/]/).pop();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};

const mimeOf = (mimeType) => String(mimeType || '').split(';')[0].trim().toLowerCase();

// Which extractor handles this file. Extension wins: students rename files, but rarely both ways.
function resolveKind(filename, mimeType) {
  const ext = extensionOf(filename);
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const mime = mimeOf(mimeType);
  if (mime.startsWith('text/')) return 'text';
  return MIME_KIND[mime] || null;
}

// `isSupported` is called by the browser and the API, so it takes either a filename or a MIME type.
function isSupported(filenameOrMime) {
  const value = String(filenameOrMime || '').trim().toLowerCase();
  if (!value) return false;
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(value)) return value.startsWith('text/') || Boolean(MIME_KIND[value]);
  return Boolean(EXT_KIND[extensionOf(value)]);
}

// ---------------------------------------------------------------------------
// ZIP reading (deflate + stored only)
// ---------------------------------------------------------------------------
// The archive comment trails the record, so EOCD is found by scanning the last 64 KiB.
function findEndOfCentral(buf) {
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === SIG.end) return i;
  }
  return -1;
}

// A name that escapes the archive root is hostile, not merely useless.
const isUnsafeName = (name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..');

// Walk the central directory and keep only the entries `isWanted` asks for, so nothing else is
// ever touched. Sizes are validated before any byte is inflated.
function indexEntries(buf, isWanted) {
  const end = findEndOfCentral(buf);
  if (end < 0) throw fail('BAD_ZIP', 'not a zip file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (cdOffset === ZIP64_MARK || count === 0xffff) throw fail('BAD_ZIP', 'zip64 archives are not supported');
  const cdEnd = cdOffset + cdSize;
  if (count === 0 || cdEnd > buf.length) throw fail('BAD_ZIP', 'central directory is missing or out of bounds');

  const wanted = new Map();
  let budget = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > cdEnd || buf.readUInt32LE(p) !== SIG.central) throw fail('BAD_ZIP', 'central directory is corrupt');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (isUnsafeName(name)) throw fail('BAD_ZIP', `archive entry outside the document root: ${name}`);
    if (!isWanted(name)) continue;
    if (flags & FLAG_ENCRYPTED) throw fail('BAD_ZIP', `encrypted entries are not supported: ${name}`);
    if (compressedSize === ZIP64_MARK || uncompressedSize === ZIP64_MARK) {
      throw fail('BAD_ZIP', `zip64 entry is not supported: ${name}`);
    }
    budget += uncompressedSize;
    if (budget > MAX_INFLATE) throw fail('BAD_ZIP', 'archive expands to more than 40 MB');
    wanted.set(name, { method, compressedSize, uncompressedSize, localOffset });
  }
  return wanted;
}

function inflateEntry(buf, { method, compressedSize, uncompressedSize, localOffset }) {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG.local) {
    throw fail('BAD_ZIP', 'local file header is corrupt');
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  if (start + compressedSize > buf.length) throw fail('BAD_ZIP', 'entry data is truncated');
  const raw = buf.subarray(start, start + compressedSize);
  if (method === 0) return raw;
  if (method !== 8) throw fail('BAD_ZIP', `unsupported compression method ${method}`);
  try {
    // Trusting the declared size here also stops a header that under-reports its payload.
    return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(uncompressedSize, MAX_INFLATE)) });
  } catch {
    throw fail('BAD_ZIP', 'entry data could not be inflated');
  }
}

// Map of the wanted entries (name -> inflated Buffer).
function unzip(buf, isWanted) {
  const files = new Map();
  let total = 0;
  for (const [name, meta] of indexEntries(buf, isWanted)) {
    const data = inflateEntry(buf, meta);
    total += data.length;
    if (total > MAX_INFLATE) throw fail('BAD_ZIP', 'archive expands to more than 40 MB');
    files.set(name, data);
  }
  return files;
}

// ---------------------------------------------------------------------------
// XML -> plain text
// ---------------------------------------------------------------------------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeXml(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

// Paragraph/row boundaries must become newlines *before* the tags disappear, otherwise every
// document collapses into a single unreadable line.
function xmlText(xml) {
  return decodeXml(
    String(xml)
      .replace(/<\/(?:w|a):p>|<\/w:tr>/g, '\n')
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<(?:w:tab|w:ptab)\s*\/>/g, '\t')
      .replace(/<(?:w:br|w:cr|a:br)\s*\/>/g, '\n')
      .replace(/<[^>]*>/g, ''),
  );
}

// Control characters that Word leaves behind (vertical tab, form feed, ...) break the UI.
function stripControlChars(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10 || code >= 32) out += ch;
  }
  return out;
}

function normalise(raw) {
  return stripControlChars(String(raw).replace(/\r\n?/g, '\n'))
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Per-format extraction
// ---------------------------------------------------------------------------
const DOCX_PART = /^word\/(?:document|footnotes|endnotes)\.xml$|^word\/(?:header|footer)[^/]*\.xml$/;
const PPTX_PART = /^ppt\/(slides|notesSlides)\/(?:notesSlide|slide)(\d+)\.xml$/;
const XLSX_PART = /^xl\/(?:sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/;

// document.xml first, then footnotes/endnotes/headers/footers in a stable order.
function docxText(files) {
  const rank = (name) => (name === 'word/document.xml' ? 0 : 1);
  const names = [...files.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((name) => xmlText(files.get(name).toString('utf8'))).join('\n\n');
}

function pptxText(files) {
  const slides = new Map();
  const notes = new Map();
  for (const [name, data] of files) {
    const match = PPTX_PART.exec(name);
    if (!match) continue;
    (match[1] === 'slides' ? slides : notes).set(Number(match[2]), data.toString('utf8'));
  }
  const order = (map) => [...map.keys()].sort((a, b) => a - b);
  const parts = [];
  for (const index of order(slides)) {
    parts.push(xmlText(slides.get(index)));
    if (notes.has(index)) parts.push(xmlText(notes.get(index))); // speaker notes belong to this slide
  }
  for (const index of order(notes)) if (!slides.has(index)) parts.push(xmlText(notes.get(index)));
  return parts.join('\n\n');
}

// <si><t>Hello</t></si>, or the same text split over <r> runs.
function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]));
}

const attrOf = (attrs, name) => (new RegExp(`${name}="([^"]*)"`).exec(attrs) || [])[1];

function cellText(attrs, inner, shared) {
  const type = attrOf(attrs, 't') || 'n';
  if (type === 'inlineStr') return xmlText(inner).trim();
  const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
  if (!value) return '';
  if (type === 's') {
    const index = Number(decodeXml(value[1]).trim());
    return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : '';
  }
  return decodeXml(value[1]).trim();
}

// One line per row, cells joined by a tab - it keeps columns readable in the note editor.
function sheetText(xml, shared) {
  const lines = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [...row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
      .map((m) => cellText(m[1], m[2] || '', shared));
    if (cells.some((cell) => cell !== '')) lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function xlsxText(files) {
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheets = [...files.keys()]
    .map((name) => ({ name, match: /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name) }))
    .filter((sheet) => sheet.match)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  return sheets.map((sheet) => sheetText(files.get(sheet.name).toString('utf8'), shared)).join('\n\n');
}

const EXTRACTORS = { docx: [DOCX_PART, docxText], pptx: [PPTX_PART, pptxText], xlsx: [XLSX_PART, xlsxText] };

function officeText(kind, buf, meta) {
  const [pattern, extract] = EXTRACTORS[kind];
  const files = unzip(buf, (name) => pattern.test(name));
  if (!files.size) throw fail('BAD_ZIP', `not a valid .${kind} file - no readable parts inside`);
  meta.entries = [...files.keys()].sort();
  return extract(files);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Buffer, Uint8Array or base64 text (what the browser posts).
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') {
    const base64 = input.replace(/\s+/g, '');
    // Reject raw text early: Buffer.from(..., 'base64') would happily return garbage.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail('UNSUPPORTED', 'file.data must be base64');
    return Buffer.from(base64, 'base64');
  }
  throw fail('EMPTY', 'file is empty - nothing was uploaded');
}

function finish(kind, parts, meta) {
  let text = normalise(parts);
  if (!text) throw fail('EMPTY', 'no readable text found in this file');
  if (text.length > MAX_TEXT) {
    let cut = MAX_TEXT;
    const last = text.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never split a surrogate pair
    text = text.slice(0, cut);
    meta.truncated = true;
  }
  return { kind, text, meta };
}

// { filename, mimeType, buffer } -> { kind, text, meta: { kind, entries, truncated } }
// Throws an Error with .code = UNSUPPORTED | TOO_LARGE | BAD_ZIP | EMPTY.
function extractText({ filename, mimeType, buffer } = {}) {
  const kind = resolveKind(filename, mimeType);
  if (!kind) {
    const hint = extensionOf(filename) || mimeOf(mimeType) || '(no name)';
    throw fail('UNSUPPORTED', `unsupported file type ${hint} - use ${SUPPORTED_EXTENSIONS.join(', ')}`);
  }
  const buf = toBuffer(buffer);
  if (!buf.length) throw fail('EMPTY', 'file is empty - nothing was uploaded');
  if (buf.length > MAX_BYTES) throw fail('TOO_LARGE', 'file too large (max 20 MB)');

  const meta = { kind, entries: [], truncated: false };
  // Images and PDFs are read by the AI vision route; pretending to extract text here would lie.
  if (kind === 'binary') return { kind, text: '', meta };
  return finish(kind, kind === 'text' ? buf.toString('utf8') : officeText(kind, buf, meta), meta);
}

module.exports = {
  extractText, isSupported, SUPPORTED_EXTENSIONS, MAX_BYTES, MAX_TEXT,
};
