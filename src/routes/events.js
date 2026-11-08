// Calendar events: deadlines, exams, presentations, classes. One row per event.
const express = require('express');
const { wrap, idParam, isId, isDate, isTime, clean, fixEvent, EVENT_KINDS } = require('../lib/helpers');

module.exports = ({ q, one, subjectExists }) => {
  const router = express.Router();
  idParam(router);

  router.get('/events', wrap(async (req, res) => {
    const { from, to } = req.query;
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    const rows = from && to
      ? await q(
        'SELECT * FROM events WHERE user_id = $1 AND event_date >= $2 AND event_date <= $3 ORDER BY event_date, start_time, id',
        [req.userId, from, to],
      )
      : await q('SELECT * FROM events WHERE user_id = $1 ORDER BY event_date, start_time, id', [req.userId]);
    res.json(rows.map(fixEvent));
  }));

  router.post('/events', wrap(async (req, res) => {
    const { title, event_date, kind, start_time, details, subject_id } = req.body || {};
    if (!clean(title) || !event_date) return res.status(400).json({ error: 'title and event_date required' });
    if (!isDate(event_date)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
    if (start_time && !isTime(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    if (subject_id && !(await subjectExists(req.userId, subject_id))) return res.status(400).json({ error: 'subject does not exist' });
    res.status(201).json(fixEvent(await one(
      `INSERT INTO events (user_id, title, event_date, kind, start_time, details, subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.userId, clean(title), event_date, EVENT_KINDS.includes(kind) ? kind : 'other',
        start_time || null, clean(details), subject_id || null],
    )));
  }));

  router.put('/events/:id', wrap(async (req, res) => {
    const { title, event_date, kind, start_time, details, done } = req.body || {};
    if (event_date && !isDate(event_date)) return res.status(400).json({ error: 'event_date must be YYYY-MM-DD' });
    if (start_time && !isTime(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    const row = await one(
      `UPDATE events SET title = COALESCE($1, title), event_date = COALESCE($2, event_date),
         kind = COALESCE($3, kind), start_time = COALESCE($4, start_time), details = COALESCE($5, details),
         done = COALESCE($6, done)
       WHERE id = $7 AND user_id = $8 RETURNING *`,
      [clean(title), event_date || null, EVENT_KINDS.includes(kind) ? kind : null, start_time || null,
        clean(details), typeof done === 'boolean' ? done : null, req.params.id, req.userId],
    );
    if (!row) return res.status(404).json({ error: 'event not found' });
    res.json(fixEvent(row));
  }));

  router.delete('/events/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'invalid id' });
    const rows = await q('DELETE FROM events WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'event not found' });
    res.json({ deleted: true });
  }));

  return router;
};
