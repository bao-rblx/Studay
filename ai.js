// Studay AI features.
// Primary: Google Gemini (src/gemini.js), called from the server only.
// Fallback: small offline helpers below, used when the key is missing or the API fails,
// so the page always gets an answer plus a notice explaining why it is basic.
const { callGemini, requestJson, AiError } = require('./src/gemini');

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,of,to,in,on,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,may,might,must,as,it,its,this,that,these,those,from,not,no,so,such,than,too,very,just,also,there,their,they,them,his,her,our,you,your,we,us,i,he,she,my,me,ours'.split(',')
);
const EVENT_KINDS = ['deadline', 'exam', 'presentation', 'class', 'other'];
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));

const NOTICES = {
  no_key: 'AI key not configured - using the basic offline helper.',
  rate_limited: 'The AI is busy (free quota reached). Showing a basic offline version instead - try again in a minute.',
  timeout: 'The AI took too long to answer. Showing a basic offline version instead.',
  upstream: 'The AI service is unavailable right now. Showing a basic offline version instead.',
  empty: 'The AI returned nothing usable. Showing a basic offline version instead.',
  bad_output: 'The AI returned something we could not read. Showing a basic offline version instead.',
};

function aiOptions(o = {}) {
  return {
    apiKey: o.apiKey !== undefined ? o.apiKey : process.env.GEMINI_API_KEY,
    model: o.model || process.env.GEMINI_MODEL || undefined,
    timeoutMs: o.timeoutMs || Number(process.env.GEMINI_TIMEOUT_MS) || undefined,
    fetchImpl: o.fetchImpl,
    log: o.log || console,
  };
}

// Run `online` with Gemini; on any failure (or no key) run `offline` and attach a notice.
async function withFallback(name, online, offline, o) {
  const opts = aiOptions(o);
  if (!opts.apiKey) return { source: 'offline', fallback_reason: 'no_key', notice: NOTICES.no_key, ...offline() };
  try {
    const out = await online(opts);
    if (!out) throw new AiError('bad_output', 'AI output had none of the requested fields');
    return { source: 'gemini', ...out };
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : 'upstream';
    opts.log.warn(`[ai] ${name}: falling back to offline helper: ${kind} (${err.message})`);
    return { source: 'offline', fallback_reason: kind, notice: NOTICES[kind], ...offline() };
  }
}

// ---------------------------------------------------------------------------
// 1. Summary + quiz from text
// ---------------------------------------------------------------------------
function splitSentences(text) {
  return text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20);
}
function keywords(text, limit = 8) {
  const freq = new Map();
  for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').split(/\s+/)) {
    if (w.length > 3 && !STOPWORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}
function summarize(text) {
  const sentences = splitSentences(text);
  const keySet = new Set(keywords(text));
  const ranked = sentences
    .map((s, i) => {
      const words = s.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').split(/\s+/);
      const score = words.reduce((n, w) => n + (keySet.has(w) ? 1 : 0), 0) / Math.max(1, Math.sqrt(words.length)) + (i === 0 ? 0.5 : 0);
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, 3).map((r) => r.s).sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b));
  return {
    summary: top.join(' ') || 'Not enough text to summarise - add at least a paragraph.',
    key_points: ranked.slice(0, 5).map((r) => (r.s.length > 140 ? r.s.slice(0, 137) + '...' : r.s)),
  };
}
// Correct answer = a sentence from the text; distractors = other sentences.
function makeQuiz(text) {
  const sentences = splitSentences(text);
  return sentences.slice(0, 5).map((s, i) => {
    const others = sentences.filter((x) => x !== s).slice(0, 3);
    while (others.length < 2) others.push('This topic was not covered in the notes.');
    return {
      question: `Q${i + 1}: Which statement best matches your notes?`,
      options: [s, ...others],
      answer_index: 0,
      explanation: `Taken directly from your notes: "${s.length > 100 ? s.slice(0, 97) + '...' : s}"`,
    };
  });
}
const normMode = (mode) => (['summary', 'quiz'].includes(mode) ? mode : 'all');

function generateOffline(text, mode = 'all') {
  const m = normMode(mode);
  const out = {};
  if ((m === 'all' || m === 'summary') && text.trim().length >= 30) out.summary = summarize(text);
  if (m === 'all' || m === 'quiz') out.quiz = makeQuiz(text);
  return out;
}

// Keep only well-formed items so a malformed AI answer cannot break the page.
function sanitizeSummary(s) {
  if (!s || typeof s.summary !== 'string') return undefined;
  return { summary: s.summary, key_points: Array.isArray(s.key_points) ? s.key_points.map(String).slice(0, 8) : [] };
}
function sanitizeQuiz(list) {
  if (!Array.isArray(list)) return undefined;
  return list
    .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2
      && Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < q.options.length)
    .slice(0, 10)
    .map((q) => ({ question: String(q.question), options: q.options.map(String), answer_index: q.answer_index, explanation: String(q.explanation || '') }));
}
function sanitize(ai, mode) {
  const m = normMode(mode);
  const out = {};
  if (m === 'all' || m === 'summary') { const s = sanitizeSummary(ai.summary); if (s) out.summary = s; }
  if (m === 'all' || m === 'quiz') { const q = sanitizeQuiz(ai.quiz); if (q && q.length) out.quiz = q; }
  return out;
}

async function generateStudyAids(text, mode = 'all', o) {
  return withFallback('study aids', async (opts) => {
    const out = sanitize(await callGemini(text, normMode(mode), opts), mode);
    return Object.keys(out).length ? out : null;
  }, () => generateOffline(text, mode), o);
}

// ---------------------------------------------------------------------------
// 2. Timetable scan: image -> list of subjects for the user to confirm
// ---------------------------------------------------------------------------
const TIMETABLE_PROMPT = 'This image is a student timetable or course list. Extract every distinct subject. '
  + 'Return JSON: {"subjects": [{"name": string, "teacher": string|null, "room": string|null, '
  + '"schedule": [{"day": 0-6 (0 = Sunday, 1 = Monday), "start": "HH:MM"|null, "end": "HH:MM"|null, "room": string|null}]}]}. '
  + 'Merge repeated classes of the same subject into one entry with several schedule items. '
  + 'Keep names in the original language. Use null when something is not visible. Do not invent subjects.';

function sanitizeSubjects(list) {
  if (!Array.isArray(list)) return [];
  const str = (v) => (v === undefined || v === null || !String(v).trim() ? null : String(v).trim().slice(0, 120));
  return list
    .filter((s) => s && str(s.name))
    .slice(0, 30)
    .map((s) => ({
      name: str(s.name),
      teacher: str(s.teacher),
      room: str(s.room),
      schedule: (Array.isArray(s.schedule) ? s.schedule : [])
        .filter((c) => c && Number.isInteger(Number(c.day)) && Number(c.day) >= 0 && Number(c.day) <= 6)
        .slice(0, 14)
        .map((c) => ({ day: Number(c.day), start: isTime(c.start) ? c.start : null, end: isTime(c.end) ? c.end : null, room: str(c.room) })),
    }));
}

async function scanTimetable({ mimeType, data }, o) {
  return withFallback('timetable scan', async (opts) => {
    const out = await requestJson([{ text: TIMETABLE_PROMPT }, { inline_data: { mime_type: mimeType, data } }], { ...opts, temperature: 0.1 });
    const subjects = sanitizeSubjects(out && out.subjects);
    if (!subjects.length) throw new AiError('empty', 'no subjects found in the image');
    return { subjects };
  }, () => ({ subjects: [] }), o);
}

// ---------------------------------------------------------------------------
// 3. Quick note: "present databases next week" -> calendar event
// ---------------------------------------------------------------------------
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);

// Offline: keyword + date rules. Good enough for English shorthand; Gemini handles the rest.
function parseQuickNoteOffline(text, today, subjects = []) {
  const t = text.toLowerCase();
  const base = new Date(`${today}T00:00:00Z`);
  let date = null;
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const dm = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/); // day/month, as used in Vietnam
  if (iso && isDate(iso[0])) date = iso[0];
  else if (dm) {
    const y = dm[3] ? Number(dm[3]) : base.getUTCFullYear();
    const cand = `${y}-${pad(dm[2])}-${pad(dm[1])}`;
    if (isDate(cand)) date = cand;
  } else if (/\btomorrow\b|ngày mai/.test(t)) date = ymd(addDays(base, 1));
  else if (/\btoday\b|hôm nay/.test(t)) date = today;
  else {
    const named = DAY_NAMES.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    const nextWeek = /\bnext week\b|tuần sau|tuần tới/.test(t);
    const nextMonday = ((1 - base.getUTCDay() + 7) % 7) || 7;
    if (named >= 0 && nextWeek) {
      date = ymd(addDays(base, nextMonday + ((named + 6) % 7))); // that weekday in next week (Mon-Sun)
    } else if (named >= 0) {
      date = ymd(addDays(base, ((named - base.getUTCDay() + 7) % 7) || 7)); // the coming one
    } else if (nextWeek) {
      date = ymd(addDays(base, nextMonday));
    } else {
      const inDays = t.match(/\bin (\d{1,3}) days?\b/);
      if (inDays) date = ymd(addDays(base, Number(inDays[1])));
    }
  }
  const kind = /present|thuyết trình/.test(t) ? 'presentation'
    : /exam|test|midterm|final|thi\b|kiểm tra/.test(t) ? 'exam'
      : /deadline|due|submit|nộp|assignment|homework|bài tập/.test(t) ? 'deadline' : 'other';
  const time = t.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  const subject = subjects.find((s) => s.name && t.includes(s.name.toLowerCase()));
  const title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
  return {
    event: date ? { title, kind, event_date: date, start_time: time ? `${pad(time[1])}:${time[2]}` : null, subject_id: subject ? subject.id : null, details: null } : null,
  };
}

function sanitizeEvent(e, subjects) {
  if (!e || !e.title || !isDate(e.event_date)) return null;
  const subject = subjects.find((s) => s.id === Number(e.subject_id));
  return {
    title: String(e.title).slice(0, 120),
    kind: EVENT_KINDS.includes(e.kind) ? e.kind : 'other',
    event_date: e.event_date,
    start_time: isTime(e.start_time) ? e.start_time : null,
    subject_id: subject ? subject.id : null,
    details: e.details ? String(e.details).slice(0, 500) : null,
  };
}

async function parseQuickNote(text, { today, subjects = [] } = {}, o) {
  const day = isDate(today) ? today : new Date().toISOString().slice(0, 10);
  return withFallback('quick note', async (opts) => {
    const prompt = `Today is ${day} (${DAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()]}). A student wrote this quick note:\n"${text}"\n`
      + `Known subjects: ${JSON.stringify(subjects.map((s) => ({ id: s.id, name: s.name })))}\n`
      + 'If the note mentions something that happens on a date (deadline, exam, presentation, class...), return '
      + '{"event": {"title": short title, "kind": "deadline"|"exam"|"presentation"|"class"|"other", "event_date": "YYYY-MM-DD", '
      + '"start_time": "HH:MM"|null, "subject_id": id from the list or null, "details": string|null}}. '
      + '"next week" without a weekday means Monday of next week. If there is no date, return {"event": null}. '
      + 'Write the title in the same language as the note.';
    const out = await requestJson([{ text: prompt }], { ...opts, temperature: 0.1 });
    if (!out || !('event' in out)) throw new AiError('bad_output', 'missing event field');
    return { event: sanitizeEvent(out.event, subjects) };
  }, () => parseQuickNoteOffline(text, day, subjects), o);
}

// ---------------------------------------------------------------------------
// 4. Teacher material: PDF / image / text -> extracted text + summary
// ---------------------------------------------------------------------------
const MATERIAL_PROMPT = 'This is study material a teacher gave to a student. Return JSON: '
  + '{"title": short title, "content": the full readable text of the material as plain text (keep headings, lists and formulas), '
  + '"summary": {"summary": 3-6 sentence summary, "key_points": string[] (5-8 items)}}. '
  + 'Write the summary in the same language as the material. Do not invent facts.';

async function readMaterial({ mimeType, data, text, filename }, o) {
  const fallbackTitle = (filename || 'Material').replace(/\.[^.]+$/, '').slice(0, 80);
  const offline = () => {
    if (!text || text.trim().length < 30) return { title: fallbackTitle, content: text || '', summary: null };
    return { title: fallbackTitle, content: text, summary: summarize(text) };
  };
  return withFallback('material', async (opts) => {
    const parts = data
      ? [{ text: MATERIAL_PROMPT }, { inline_data: { mime_type: mimeType, data } }]
      : [{ text: `${MATERIAL_PROMPT}\n\nMATERIAL:\n${String(text).slice(0, 30000)}` }];
    const out = await requestJson(parts, opts);
    const content = out && typeof out.content === 'string' && out.content.trim() ? out.content : text;
    const summary = sanitizeSummary(out && out.summary);
    if (!content || !summary) throw new AiError('bad_output', 'material output missing content or summary');
    return { title: out.title ? String(out.title).slice(0, 120) : fallbackTitle, content, summary };
  }, offline, o);
}

// ---------------------------------------------------------------------------
// 5. Companion chat: answer a question using the subject's notes and materials
// ---------------------------------------------------------------------------
async function askCompanion(question, context, o) {
  return withFallback('companion', async (opts) => {
    const prompt = 'You are Studay, a cheerful, encouraging study buddy. Answer the student briefly (under 150 words), '
      + 'in the same language as the question, using the study context when it is relevant. If the context does not cover it, say so '
      + 'and give a general explanation. Return JSON: {"answer": string}.\n\n'
      + `STUDY CONTEXT:\n${String(context || '(none)').slice(0, 20000)}\n\nQUESTION:\n${question}`;
    const out = await requestJson([{ text: prompt }], { ...opts, temperature: 0.6 });
    return out && typeof out.answer === 'string' && out.answer.trim() ? { answer: out.answer } : null;
  }, () => {
    const hits = splitSentences(String(context || ''))
      .filter((s) => keywords(question, 5).some((k) => s.toLowerCase().includes(k)))
      .slice(0, 3);
    return { answer: hits.length ? `Here is what your notes say: ${hits.join(' ')}` : "I can't think right now, but keep going - you've got this!" };
  }, o);
}

module.exports = {
  generateStudyAids, generateOffline, scanTimetable, parseQuickNote, parseQuickNoteOffline,
  readMaterial, askCompanion, sanitizeSubjects, NOTICES,
};
