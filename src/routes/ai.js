// AI-assisted endpoints. `AI` is injected by src/app.js so tests never reach Gemini.
const express = require('express');
const {
  wrap, isId, isDate, clean, checkUpload,
  AI_MIN_CHARS, AI_MAX_CHARS, MATERIAL_MAX_CHARS, QUESTION_MAX_CHARS,
} = require('../lib/helpers');

module.exports = ({ q, one, AI }) => {
  const router = express.Router();

  router.post('/ai/generate', wrap(async (req, res) => {
    const { note_id, content, mode } = req.body || {};
    let text = content;
    if (!text && note_id) {
      if (!isId(note_id)) return res.status(400).json({ error: 'invalid note_id' });
      const note = await one('SELECT title, content FROM notes WHERE id = $1 AND user_id = $2', [note_id, req.userId]);
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
  router.post('/ai/scan-timetable', wrap(async (req, res) => {
    const file = (req.body || {}).file;
    const bad = checkUpload(file);
    if (bad) return res.status(400).json({ error: bad });
    if (file.mime_type === 'application/pdf') return res.status(400).json({ error: 'upload a photo or screenshot of the timetable' });
    res.json(await AI.scanTimetable({ mimeType: file.mime_type, data: file.data }));
  }));

  // Quick note -> proposed calendar event. Nothing is saved until the user confirms.
  router.post('/ai/quick-note', wrap(async (req, res) => {
    const { text, today } = req.body || {};
    const t = clean(text);
    if (!t) return res.status(400).json({ error: 'text required' });
    if (today && !isDate(today)) return res.status(400).json({ error: 'today must be YYYY-MM-DD' });
    const subjects = await q('SELECT id, name FROM subjects WHERE user_id = $1 ORDER BY id', [req.userId]);
    res.json(await AI.parseQuickNote(t.slice(0, 500), { today, subjects }));
  }));

  // Teacher file -> extracted text + summary. The page shows it, then saves via
  // POST /api/materials. Plain text arrives in `text`; binary types are sent to Gemini.
  router.post('/ai/read-material', wrap(async (req, res) => {
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

  // Companion chat, grounded in this account's notes and materials (or one subject).
  router.post('/ai/ask', wrap(async (req, res) => {
    const { question, subject_id } = req.body || {};
    const qn = clean(question);
    if (!qn) return res.status(400).json({ error: 'question required' });
    if (qn.length > QUESTION_MAX_CHARS) return res.status(400).json({ error: 'question too long' });
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    const where = subject_id ? 'AND subject_id = $2' : '';
    const params = subject_id ? [req.userId, subject_id] : [req.userId];
    const notes = await q(`SELECT title, content FROM notes WHERE user_id = $1 ${where} ORDER BY id DESC LIMIT 20`, params);
    const mats = await q(`SELECT title, content FROM materials WHERE user_id = $1 ${where} ORDER BY id DESC LIMIT 5`, params);
    const context = [...mats, ...notes].map((r) => `## ${r.title}\n${r.content}`).join('\n\n');
    res.json(await AI.askCompanion(qn, context));
  }));

  return router;
};
