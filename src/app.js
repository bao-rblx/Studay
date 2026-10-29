// Express application: REST API + static frontend.
// The pool is injected so the tests can run against an in-memory Postgres.
const path = require('path');
const express = require('express');
const defaultAi = require('../ai');
const { isDbDown } = require('./db');

// Express 4 does not catch rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const AI_MIN_CHARS = 30;
const AI_MAX_CHARS = 12000;
const MATERIAL_MAX_CHARS = 200000;
const EVENT_KINDS = ['deadline', 'exam', 'presentation', 'class', 'other'];
const isId = (v) => /^[1-9]\d{0,9}$/.test(String(v));
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(v));
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
// Files the AI can read directly. Plain text is sent as `text` instead.
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'application/pdf'];
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const QUESTION_MAX_CHARS = 1000;
const clean = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

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

// `ai` is injectable so tests never call the real Gemini API.
function createApp({ pool, ai = {} }) {
  const AI = { ...defaultAi, ...(typeof ai === 'function' ? { generateStudyAids: ai } : ai) };
  const app = express();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const subjectExists = async (id) => isId(id) && Boolean(await one('SELECT id FROM subjects WHERE id = $1', [id]));

  app.disable('x-powered-by');
  // AI routes accept base64 images/PDFs; everything else keeps a small limit.
  // The first parser that reads the body wins, so the larger one must come first.
  app.use('/api/ai', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Reject non-numeric ids before they reach the database.
  app.param('id', (req, res, next, id) => (isId(id) ? next() : res.status(400).json({ error: 'invalid id' })));

  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // --- Subjects ---
  app.get('/api/subjects', wrap(async (req, res) => {
    res.json(await q('SELECT * FROM subjects ORDER BY created_at DESC, id DESC'));
  }));
  app.post('/api/subjects', wrap(async (req, res) => {
    const { name, color, teacher, room, schedule } = req.body || {};
    if (!clean(name)) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await one(
      'INSERT INTO subjects (name, color, teacher, room, schedule) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [clean(name), color || '#007aff', clean(teacher), clean(room), JSON.stringify(cleanSchedule(schedule))],
    ));
  }));
  // Several subjects at once: used after the user confirms an AI timetable scan.
  app.post('/api/subjects/bulk', wrap(async (req, res) => {
    const list = (req.body || {}).subjects;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'subjects array required' });
    if (list.length > 30) return res.status(400).json({ error: 'at most 30 subjects at once' });
    if (list.some((s) => !s || !clean(s.name))) return res.status(400).json({ error: 'every subject needs a name' });
    const created = [];
    for (const s of list) {
      created.push(await one(
        'INSERT INTO subjects (name, color, teacher, room, schedule) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [clean(s.name), s.color || '#007aff', clean(s.teacher), clean(s.room), JSON.stringify(cleanSchedule(s.schedule))],
      ));
    }
    res.status(201).json(created);
  }));
  app.put('/api/subjects/:id', wrap(async (req, res) => {
    const { name, color, teacher, room, schedule } = req.body || {};
    const row = await one(
      `UPDATE subjects SET name = COALESCE($1, name), color = COALESCE($2, color),
         teacher = COALESCE($3, teacher), room = COALESCE($4, room), schedule = COALESCE($5, schedule)
       WHERE id = $6 RETURNING *`,
      [clean(name), color ?? null, clean(teacher), clean(room),
        schedule === undefined ? null : JSON.stringify(cleanSchedule(schedule)), req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'subject not found' });
    res.json(row);
  }));
  app.delete('/api/subjects/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM subjects WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'subject not found' });
    res.json({ deleted: true });
  }));

  // --- Notes ---
  app.get('/api/notes', wrap(async (req, res) => {
    const { subject_id } = req.query;
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    res.json(subject_id
      ? await q('SELECT * FROM notes WHERE subject_id = $1 ORDER BY created_at DESC, id DESC', [subject_id])
      : await q('SELECT * FROM notes ORDER BY created_at DESC, id DESC'));
  }));
  app.post('/api/notes', wrap(async (req, res) => {
    const { subject_id, title, content } = req.body || {};
    if (!subject_id || !title || !content) return res.status(400).json({ error: 'subject_id, title, content required' });
    if (!(await subjectExists(subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(await one(
      'INSERT INTO notes (subject_id, title, content) VALUES ($1, $2, $3) RETURNING *',
      [subject_id, title, content],
    ));
  }));
  app.put('/api/notes/:id', wrap(async (req, res) => {
    const { title, content } = req.body || {};
    const row = await one(
      'UPDATE notes SET title = COALESCE($1, title), content = COALESCE($2, content) WHERE id = $3 RETURNING *',
      [title ?? null, content ?? null, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'note not found' });
    res.json(row);
  }));
  app.delete('/api/notes/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM notes WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'note not found' });
    res.json({ deleted: true });
  }));

  // --- Calendar events ---
  // Always send event_date as 'YYYY-MM-DD'. Real Postgres already does (type parser in db.js);
  // pg-mem in the tests returns a Date at UTC midnight.
  const fixEvent = (e) => (e && e.event_date instanceof Date ? { ...e, event_date: e.event_date.toISOString().slice(0, 10) } : e);

  app.get('/api/events', wrap(async (req, res) => {
    const { from, to } = req.query;
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const rows = from && to
      ? await q('SELECT * FROM events WHERE event_date >= $1 AND event_date <= $2 ORDER BY event_date, start_time, id', [from, to])
      : await q('SELECT * FROM events ORDER BY event_date, start_time, id');
    res.json(rows.map(fixEvent));
  }));
  app.post('/api/events', wrap(async (req, res) => {
    const { title, event_date, kind, start_time, details, subject_id } = req.body || {};
    if (!clean(title) || !event_date) return res.status(400).json({ error: 'title and event_date required' });
    if (!isDate(event_date)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
    if (start_time && !isTime(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    if (subject_id && !(await subjectExists(subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(fixEvent(await one(
      `INSERT INTO events (title, event_date, kind, start_time, details, subject_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [clean(title), event_date, EVENT_KINDS.includes(kind) ? kind : 'other', start_time || null, clean(details), subject_id || null],
    )));
  }));
  app.put('/api/events/:id', wrap(async (req, res) => {
    const { title, event_date, kind, start_time, details, done } = req.body || {};
    if (event_date && !isDate(event_date)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
    if (start_time && !isTime(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    const row = await one(
      `UPDATE events SET title = COALESCE($1, title), event_date = COALESCE($2, event_date),
         kind = COALESCE($3, kind), start_time = COALESCE($4, start_time), details = COALESCE($5, details),
         done = COALESCE($6, done)
       WHERE id = $7 RETURNING *`,
      [clean(title), event_date || null, EVENT_KINDS.includes(kind) ? kind : null, start_time || null,
        clean(details), typeof done === 'boolean' ? done : null, req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'event not found' });
    res.json(fixEvent(row));
  }));
  app.delete('/api/events/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM events WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'event not found' });
    res.json({ deleted: true });
  }));

  // --- Materials (teacher files, stored as extracted text + AI summary) ---
  app.get('/api/materials', wrap(async (req, res) => {
    const { subject_id } = req.query;
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    res.json(subject_id
      ? await q('SELECT * FROM materials WHERE subject_id = $1 ORDER BY created_at DESC, id DESC', [subject_id])
      : await q('SELECT * FROM materials ORDER BY created_at DESC, id DESC'));
  }));
  app.post('/api/materials', wrap(async (req, res) => {
    const { subject_id, title, filename, content, summary } = req.body || {};
    if (!subject_id || !clean(title) || !clean(content)) return res.status(400).json({ error: 'subject_id, title, content required' });
    if (!(await subjectExists(subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(await one(
      'INSERT INTO materials (subject_id, title, filename, content, summary) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [subject_id, clean(title), clean(filename), String(content).slice(0, MATERIAL_MAX_CHARS),
        summary && typeof summary === 'object' ? JSON.stringify(summary) : null],
    ));
  }));
  app.delete('/api/materials/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM materials WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'material not found' });
    res.json({ deleted: true });
  }));

  // --- AI-assisted feature ---
  app.post('/api/ai/generate', wrap(async (req, res) => {
    const { note_id, content, mode } = req.body || {};
    let text = content;
    if (!text && note_id) {
      if (!isId(note_id)) return res.status(400).json({ error: 'invalid note_id' });
      const note = await one('SELECT title, content FROM notes WHERE id = $1', [note_id]);
      if (!note) return res.status(404).json({ error: 'note not found' });
      text = `${note.title}\n${note.content}`;
    }
    text = String(text || '').trim();
    if (!text) return res.status(400).json({ error: 'content or note_id required' });
    if (text.length < AI_MIN_CHARS) return res.status(400).json({ error: 'note text too short - paste at least a paragraph' });
    res.json(await AI.generateStudyAids(text.slice(0, AI_MAX_CHARS), mode || 'all'));
  }));

  // Timetable photo -> proposed subjects. Nothing is saved: the user reviews them,
  // then the page calls POST /api/subjects/bulk.
  app.post('/api/ai/scan-timetable', wrap(async (req, res) => {
    const file = (req.body || {}).file;
    const bad = checkUpload(file);
    if (bad) return res.status(400).json({ error: bad });
    if (file.mime_type === 'application/pdf') return res.status(400).json({ error: 'upload a photo or screenshot of the timetable' });
    res.json(await AI.scanTimetable({ mimeType: file.mime_type, data: file.data }));
  }));

  // Quick note -> proposed calendar event. Nothing is saved until the user confirms.
  app.post('/api/ai/quick-note', wrap(async (req, res) => {
    const { text, today } = req.body || {};
    const t = clean(text);
    if (!t) return res.status(400).json({ error: 'text required' });
    if (today && !isDate(today)) return res.status(400).json({ error: 'today must be YYYY-MM-DD' });
    const subjects = await q('SELECT id, name FROM subjects ORDER BY id');
    res.json(await AI.parseQuickNote(t.slice(0, 500), { today, subjects }));
  }));

  // Teacher file -> extracted text + summary. The page shows it, then saves via POST /api/materials.
  app.post('/api/ai/read-material', wrap(async (req, res) => {
    const { file, text, filename } = req.body || {};
    if (file) {
      const bad = checkUpload(file);
      if (bad) return res.status(400).json({ error: bad });
      return res.json(await AI.readMaterial({ mimeType: file.mime_type, data: file.data, filename }));
    }
    const t = String(text || '').trim();
    if (t.length < AI_MIN_CHARS) return res.status(400).json({ error: 'file or text (at least a paragraph) required' });
    res.json(await AI.readMaterial({ text: t.slice(0, MATERIAL_MAX_CHARS), filename }));
  }));

  // Companion chat, grounded in one subject's notes and materials (or everything).
  app.post('/api/ai/ask', wrap(async (req, res) => {
    const { question, subject_id } = req.body || {};
    const qn = clean(question);
    if (!qn) return res.status(400).json({ error: 'question required' });
    if (qn.length > QUESTION_MAX_CHARS) return res.status(400).json({ error: 'question too long' });
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    const where = subject_id ? 'WHERE subject_id = $1' : '';
    const params = subject_id ? [subject_id] : [];
    const notes = await q(`SELECT title, content FROM notes ${where} ORDER BY id DESC LIMIT 20`, params);
    const mats = await q(`SELECT title, content FROM materials ${where} ORDER BY id DESC LIMIT 5`, params);
    const context = [...mats, ...notes].map((r) => `## ${r.title}\n${r.content}`).join('\n\n');
    res.json(await AI.askCompanion(qn, context));
  }));

  // Quiz from a subject's saved material (or a single material).
  app.post('/api/ai/quiz', wrap(async (req, res) => {
    const { material_id, subject_id } = req.body || {};
    let rows;
    if (material_id) {
      if (!isId(material_id)) return res.status(400).json({ error: 'invalid material_id' });
      rows = await q('SELECT title, content FROM materials WHERE id = $1', [material_id]);
    } else if (subject_id) {
      if (!isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
      rows = [
        ...await q('SELECT title, content FROM materials WHERE subject_id = $1 ORDER BY id DESC LIMIT 5', [subject_id]),
        ...await q('SELECT title, content FROM notes WHERE subject_id = $1 ORDER BY id DESC LIMIT 10', [subject_id]),
      ];
    } else return res.status(400).json({ error: 'material_id or subject_id required' });
    const text = rows.map((r) => `${r.title}\n${r.content}`).join('\n\n').trim();
    if (text.length < AI_MIN_CHARS) return res.status(400).json({ error: 'not enough study material yet - add notes or a file first' });
    res.json(await AI.generateStudyAids(text.slice(0, AI_MAX_CHARS), 'quiz'));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
    if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return res.status(400).json({ error: 'invalid value' });
    if (err.code === '23503') return res.status(400).json({ error: 'referenced record does not exist' });
    if (isDbDown(err)) {
      console.warn('[db] request failed, database unreachable:', err.code || err.message);
      return res.status(503).set('Retry-After', '10').json({ error: 'database is waking up - try again in a few seconds' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, cleanSchedule, isDate, isTime };
