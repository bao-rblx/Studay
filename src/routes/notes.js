// Notes: free text attached to a subject.
const express = require('express');
const { wrap, idParam, isId } = require('../lib/helpers');

module.exports = ({ q, one, subjectExists }) => {
  const router = express.Router();
  idParam(router);

  router.get('/notes', wrap(async (req, res) => {
    const { subject_id } = req.query;
    if (subject_id && !isId(subject_id)) return res.status(400).json({ error: 'invalid subject_id' });
    res.json(subject_id
      ? await q('SELECT * FROM notes WHERE user_id = $1 AND subject_id = $2 ORDER BY created_at DESC, id DESC', [req.userId, subject_id])
      : await q('SELECT * FROM notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [req.userId]));
  }));

  router.post('/notes', wrap(async (req, res) => {
    const { subject_id, title, content } = req.body || {};
    if (!subject_id || !title || !content) return res.status(400).json({ error: 'subject_id, title, content required' });
    if (!(await subjectExists(req.userId, subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(await one(
      'INSERT INTO notes (user_id, subject_id, title, content) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.userId, subject_id, title, content],
    ));
  }));

  router.put('/notes/:id', wrap(async (req, res) => {
    const { title, content } = req.body || {};
    const row = await one(
      `UPDATE notes SET title = COALESCE($1, title), content = COALESCE($2, content)
        WHERE id = $3 AND user_id = $4 RETURNING *`,
      [title ?? null, content ?? null, req.params.id, req.userId],
    );
    if (!row) return res.status(404).json({ error: 'note not found' });
    res.json(row);
  }));

  router.delete('/notes/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'note not found' });
    res.json({ deleted: true });
  }));

  return router;
};
