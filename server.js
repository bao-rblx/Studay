// Studay backend - Member A (Backend + Database)
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database setup (Node built-in, no native modules needed) ---
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, 'studay.db'));
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);
db.exec('PRAGMA foreign_keys = ON');

const run = async (sql, params = []) => {
  const r = db.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid), changes: r.changes };
};
const all = async (sql, params = []) => db.prepare(sql).all(...params);
const get = async (sql, params = []) => db.prepare(sql).get(...params);

// --- Subjects CRUD ---
app.get('/api/subjects', async (req, res) => {
  res.json(await all('SELECT * FROM subjects ORDER BY created_at DESC'));
});
app.post('/api/subjects', async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const r = await run('INSERT INTO subjects (name, color) VALUES (?, ?)', [name, color || '#4f46e5']);
  res.status(201).json(await get('SELECT * FROM subjects WHERE id = ?', [r.id]));
});
app.put('/api/subjects/:id', async (req, res) => {
  const { name, color } = req.body;
  await run('UPDATE subjects SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?', [name, color, req.params.id]);
  res.json(await get('SELECT * FROM subjects WHERE id = ?', [req.params.id]));
});
app.delete('/api/subjects/:id', async (req, res) => {
  await run('DELETE FROM subjects WHERE id = ?', [req.params.id]);
  res.json({ deleted: true });
});

// --- Notes CRUD ---
app.get('/api/notes', async (req, res) => {
  const sql = req.query.subject_id
    ? 'SELECT * FROM notes WHERE subject_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM notes ORDER BY created_at DESC';
  const params = req.query.subject_id ? [req.query.subject_id] : [];
  res.json(await all(sql, params));
});
app.post('/api/notes', async (req, res) => {
  const { subject_id, title, content } = req.body;
  if (!subject_id || !title || !content) return res.status(400).json({ error: 'subject_id, title, content required' });
  const r = await run('INSERT INTO notes (subject_id, title, content) VALUES (?, ?, ?)', [subject_id, title, content]);
  res.status(201).json(await get('SELECT * FROM notes WHERE id = ?', [r.id]));
});
app.put('/api/notes/:id', async (req, res) => {
  const { title, content } = req.body;
  await run('UPDATE notes SET title = COALESCE(?, title), content = COALESCE(?, content) WHERE id = ?', [title, content, req.params.id]);
  res.json(await get('SELECT * FROM notes WHERE id = ?', [req.params.id]));
});
app.delete('/api/notes/:id', async (req, res) => {
  await run('DELETE FROM notes WHERE id = ?', [req.params.id]);
  res.json({ deleted: true });
});

// --- Flashcards CRUD ---
app.get('/api/flashcards', async (req, res) => {
  const sql = req.query.note_id
    ? 'SELECT * FROM flashcards WHERE note_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM flashcards ORDER BY created_at DESC';
  const params = req.query.note_id ? [req.query.note_id] : [];
  res.json(await all(sql, params));
});
app.post('/api/flashcards', async (req, res) => {
  const { note_id, front, back } = req.body;
  if (!note_id || !front || !back) return res.status(400).json({ error: 'note_id, front, back required' });
  const r = await run('INSERT INTO flashcards (note_id, front, back) VALUES (?, ?, ?)', [note_id, front, back]);
  res.status(201).json(await get('SELECT * FROM flashcards WHERE id = ?', [r.id]));
});
app.delete('/api/flashcards/:id', async (req, res) => {
  await run('DELETE FROM flashcards WHERE id = ?', [req.params.id]);
  res.json({ deleted: true });
});

// --- AI-assisted feature: generate summary / flashcards / quiz from note text ---
// Member C (AI Integration). Rule-based MVP that works offline; swap with OpenAI API later.
const { generateStudyAids } = require('./ai');
app.post('/api/ai/generate', async (req, res) => {
  const { note_id, content, mode } = req.body;
  let text = content;
  if (!text && note_id) {
    const note = await get('SELECT * FROM notes WHERE id = ?', [note_id]);
    if (!note) return res.status(404).json({ error: 'note not found' });
    text = note.title + '\n' + note.content;
  }
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'content or note_id required' });
  if (String(text).trim().length < 30) return res.status(400).json({ error: 'note text too short — paste at least a paragraph' });
  const limit = 12000;
  if (text.length > limit) text = text.slice(0, limit);
  res.json(generateStudyAids(text, mode || 'all'));
});

// --- 404 + error handling ---
app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'internal server error' }); });

app.listen(PORT, () => console.log(`Studay running at http://localhost:${PORT}`));
