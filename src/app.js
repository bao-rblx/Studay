// Express application: REST API + static frontend.
// The pool is injected so the tests can run against an in-memory Postgres.
const path = require('path');
const express = require('express');
const { generateStudyAids } = require('../ai');

// Express 4 does not catch rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const AI_MIN_CHARS = 30;
const AI_MAX_CHARS = 12000;
const isId = (v) => /^[1-9]\d{0,9}$/.test(String(v));

function createApp({ pool }) {
  const app = express();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
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
    const { name, color } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await one(
      'INSERT INTO subjects (name, color) VALUES ($1, $2) RETURNING *',
      [String(name).trim(), color || '#007aff'],
    ));
  }));
  app.put('/api/subjects/:id', wrap(async (req, res) => {
    const { name, color } = req.body || {};
    const row = await one(
      'UPDATE subjects SET name = COALESCE($1, name), color = COALESCE($2, color) WHERE id = $3 RETURNING *',
      [name ?? null, color ?? null, req.params.id],
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
    if (!isId(subject_id) || !(await one('SELECT id FROM subjects WHERE id = $1', [subject_id]))) {
      return res.status(400).json({ error: 'subject does not exist' });
    }
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

  // --- Flashcards ---
  app.get('/api/flashcards', wrap(async (req, res) => {
    const { note_id } = req.query;
    if (note_id && !isId(note_id)) return res.status(400).json({ error: 'invalid note_id' });
    res.json(note_id
      ? await q('SELECT * FROM flashcards WHERE note_id = $1 ORDER BY created_at DESC, id DESC', [note_id])
      : await q('SELECT * FROM flashcards ORDER BY created_at DESC, id DESC'));
  }));
  app.post('/api/flashcards', wrap(async (req, res) => {
    const { note_id, front, back } = req.body || {};
    if (!note_id || !front || !back) return res.status(400).json({ error: 'note_id, front, back required' });
    if (!isId(note_id) || !(await one('SELECT id FROM notes WHERE id = $1', [note_id]))) {
      return res.status(400).json({ error: 'note does not exist' });
    }
    res.status(201).json(await one(
      'INSERT INTO flashcards (note_id, front, back) VALUES ($1, $2, $3) RETURNING *',
      [note_id, front, back],
    ));
  }));
  app.delete('/api/flashcards/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM flashcards WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'flashcard not found' });
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
    res.json(await generateStudyAids(text.slice(0, AI_MAX_CHARS), mode || 'all'));
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.code === '22P02') return res.status(400).json({ error: 'invalid id' });
    if (err.code === '23503') return res.status(400).json({ error: 'referenced record does not exist' });
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
