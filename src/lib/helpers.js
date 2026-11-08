// Shared constants and validators used by the route modules.
// Kept in one place so a rule (for example "a date is YYYY-MM-DD") is stated once.

// Express 4 does not catch rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const AI_MIN_CHARS = 30;
const AI_MAX_CHARS = 12000;
const MATERIAL_MAX_CHARS = 200000;
const QUESTION_MAX_CHARS = 1000;
const EVENT_KINDS = ['deadline', 'exam', 'presentation', 'class', 'other'];

const isId = (v) => /^[1-9]\d{0,9}$/.test(String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// Files the AI can read directly. Plain text and office documents are sent as `text`.
// The list grows in src/files.js; keep both in sync when adding a type.
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'];
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

// Weekly timetable entries. Anything malformed is dropped rather than stored.
function cleanSchedule(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((s) => s && Number.isInteger(Number(s.day)) && Number(s.day) >= 0 && Number(s.day) <= 6)
    .slice(0, 14)
    .map((s) => ({
      day: Number(s.day),
      start: isTime(s.start) ? s.start : null,
      end: isTime(s.end) ? s.end : null,
      room: clean(s.room),
    }));
}

// Validate a base64 upload ({ mime_type, data }). Returns an error string or null.
function checkUpload(file) {
  if (!file || typeof file.data !== 'string' || !file.data) return 'file.data (base64) required';
  if (!UPLOAD_TYPES.includes(file.mime_type)) return `unsupported file type - use ${UPLOAD_TYPES.join(', ')}`;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(file.data)) return 'file.data must be base64';
  if (Math.floor(file.data.length * 3 / 4) > UPLOAD_MAX_BYTES) return 'file too large (max 10 MB)';
  return null;
}

// Always send event_date as 'YYYY-MM-DD'. Real Postgres already does (type parser in db.js);
// pg-mem in the tests returns a Date at UTC midnight.
const fixEvent = (e) => (e && e.event_date instanceof Date ? { ...e, event_date: e.event_date.toISOString().slice(0, 10) } : e);

// Rejects a non-numeric id before it reaches the database, so a typo in a URL is a 400
// and not a failed cast. Each router installs this for its own :id routes — an
// app-level `app.param` does not reach routes declared inside a mounted router.
const idParam = (router) => router.param('id', (req, res, next, id) => (
  isId(id) ? next() : res.status(400).json({ error: 'invalid id' })
));

module.exports = {
  wrap,
  idParam,
  AI_MIN_CHARS,
  AI_MAX_CHARS,
  MATERIAL_MAX_CHARS,
  QUESTION_MAX_CHARS,
  EVENT_KINDS,
  UPLOAD_TYPES,
  UPLOAD_MAX_BYTES,
  isId,
  isDate,
  isTime,
  clean,
  cleanSchedule,
  checkUpload,
  fixEvent,
};
