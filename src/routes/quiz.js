// Quiz endpoints. Currently one AI-backed generator; the quiz wave rewrites this file
// (local question builder, answer checking, per-subject best score).
const express = require('express');
const { wrap, isId, AI_MIN_CHARS, AI_MAX_CHARS } = require('../lib/helpers');

module.exports = ({ q, AI }) => {
  const router = express.Router();

  // Quiz from a subject's saved material (or a single material).
  router.post('/ai/quiz', wrap(async (req, res) => {
    const { material_id, subject_id } = req.body || {};
    let rows;
    if (material_id) {
      if (!isId(material_id)) return res.status(400).json({ error: 'invalid material_id' });
      rows = await q('SELECT title, content FROM materials WHERE id = $1 AND user_id = $2', [material_id, req.userId]);
    } else if (subject_id) {
      if (!isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
      rows = [
        ...await q('SELECT title, content FROM materials WHERE user_id = $1 AND subject_id = $2 ORDER BY id DESC LIMIT 5', [req.userId, subject_id]),
        ...await q('SELECT title, content FROM notes WHERE user_id = $1 AND subject_id = $2 ORDER BY id DESC LIMIT 10', [req.userId, subject_id]),
      ];
    } else return res.status(400).json({ error: 'material_id or subject_id required' });
    const text = rows.map((r) => `${r.title}\n${r.content}`).join('\n\n').trim();
    if (text.length < AI_MIN_CHARS) return res.status(400).json({ error: 'not enough study material yet - add notes or a file first' });
    res.json(await AI.generateStudyAids(text.slice(0, AI_MAX_CHARS), 'quiz'));
  }));

  return router;
};
