// AI-assisted endpoints. `AI` is injected by src/app.js so tests never reach Gemini.
const express = require('express');
const {
  wrap, isId, isDate, clean, checkUpload,
  AI_MIN_CHARS, AI_MAX_CHARS, MATERIAL_MAX_CHARS, QUESTION_MAX_CHARS,
} = require('../lib/helpers');
const { extractText } = require('../files');

// What the student can actually drop, spelled out in the language of the UI.
const FILE_HINT = 'Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, image or text';
// The local extractor reports a code; each one becomes a sentence the student can act on.
const FILE_ERRORS = {
  UNSUPPORTED: `unsupported file type - drop ${FILE_HINT}`,
  TOO_LARGE: 'file too large (max 20 MB)',
  BAD_ZIP: 'that document looks damaged - save it again from Word, PowerPoint or Excel',
  EMPTY: 'no readable text in that file - is it a scan of a page?',
};

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
  // POST /api/materials. Text and Office documents are read locally, so a Word or Excel
  // file works without an AI key; only images and PDFs still need the vision model.
  // `extractor` says which path read the file (the AI's own `source` field already means
  // "gemini or offline helper", so these cannot share a name).
  router.post('/ai/read-material', wrap(async (req, res) => {
    const { file, text, filename: bodyFilename } = req.body || {};
    // New clients send file.name; older ones sent a top-level filename.
    const filename = clean(file && file.name) || clean(bodyFilename);

    if (file) {
      if (typeof file.data !== 'string' || !file.data) {
        return res.status(400).json({ error: 'file.data (base64) required' });
      }
      let local;
      try {
        local = extractText({ filename, mimeType: file.mime_type, buffer: file.data });
      } catch (err) {
        return res.status(400).json({ error: FILE_ERRORS[err.code] || `could not read that file - drop ${FILE_HINT}` });
      }
      if (local.kind === 'binary') {
        // PDFs and photos keep the original vision path, including its upload checks.
        const bad = checkUpload(file);
        if (bad) return res.status(400).json({ error: bad });
        const out = await AI.readMaterial({ mimeType: file.mime_type, data: file.data, filename });
        return res.json({ ...out, extractor: 'gemini', kind: local.kind, chars: null, truncated: false, filename });
      }
      // A short file is not an error: the AI helper simply returns no summary for it, and the
      // text is still worth saving. Only "no text at all" is refused (EMPTY above).
      const out = await AI.readMaterial({ text: local.text, filename });
      const { kind, truncated } = local.meta;
      return res.json({
        ...out, extractor: 'local', kind, chars: local.text.length, truncated, filename,
      });
    }

    const t = String(text || '').trim();
    if (t.length < AI_MIN_CHARS) return res.status(400).json({ error: 'file or text (at least a paragraph) required' });
    const out = await AI.readMaterial({ text: t.slice(0, MATERIAL_MAX_CHARS), filename });
    res.json({ ...out, extractor: 'local', kind: 'text', chars: t.length, truncated: false, filename });
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
