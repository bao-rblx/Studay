// Materials: teacher files kept as extracted text plus the AI summary.
// The original file is never stored, only what the AI (or the local extractor) read.
const express = require('express');
const { wrap, idParam, isId, clean, MATERIAL_MAX_CHARS } = require('../lib/helpers');

module.exports = ({ q, one, subjectExists }) => {
  const router = express.Router();
  idParam(router);

  router.get('/materials', wrap(async (req, res) => {
    const { subject_id } = req.query;
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    res.json(subject_id
      ? await q('SELECT * FROM materials WHERE user_id = $1 AND subject_id = $2 ORDER BY created_at DESC, id DESC', [req.userId, subject_id])
      : await q('SELECT * FROM materials WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [req.userId]));
  }));

  router.post('/materials', wrap(async (req, res) => {
    const { subject_id, title, filename, content, summary } = req.body || {};
    if (!subject_id || !clean(title) || !clean(content)) return res.status(400).json({ error: 'subject_id, title, content required' });
    if (!(await subjectExists(req.userId, subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(await one(
      `INSERT INTO materials (user_id, subject_id, title, filename, content, summary)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, subject_id, clean(title), clean(filename), String(content).slice(0, MATERIAL_MAX_CHARS),
        summary && typeof summary === 'object' ? JSON.stringify(summary) : null],
    ));
  }));

  router.delete('/materials/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM materials WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'material not found' });
    res.json({ deleted: true });
  }));

  return router;
};
