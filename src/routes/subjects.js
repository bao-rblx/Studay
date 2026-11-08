// Subjects: the course list, including the bulk create used by the AI timetable scan.
// Every query is scoped to req.userId — two accounts never see each other's rows.
const express = require('express');
const { wrap, idParam, clean, cleanSchedule } = require('../lib/helpers');

module.exports = ({ q, one }) => {
  const router = express.Router();
  idParam(router);

  router.get('/subjects', wrap(async (req, res) => {
    res.json(await q('SELECT * FROM subjects WHERE user_id = $1 ORDER BY created_at DESC, id DESC', [req.userId]));
  }));

  router.post('/subjects', wrap(async (req, res) => {
    const { name, color, teacher, room, schedule } = req.body || {};
    if (!clean(name)) return res.status(400).json({ error: 'name is required' });
    res.status(201).json(await one(
      `INSERT INTO subjects (user_id, name, color, teacher, room, schedule)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, clean(name), color || '#007aff', clean(teacher), clean(room), JSON.stringify(cleanSchedule(schedule))],
    ));
  }));

  // Several subjects at once: used after the user confirms an AI timetable scan.
  router.post('/subjects/bulk', wrap(async (req, res) => {
    const list = (req.body || {}).subjects;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'subjects array required' });
    if (list.length > 30) return res.status(400).json({ error: 'at most 30 subjects at once' });
    if (list.some((s) => !s || !clean(s.name))) return res.status(400).json({ error: 'every subject needs a name' });
    const created = [];
    for (const s of list) {
      created.push(await one(
        `INSERT INTO subjects (user_id, name, color, teacher, room, schedule)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [req.userId, clean(s.name), s.color || '#007aff', clean(s.teacher), clean(s.room), JSON.stringify(cleanSchedule(s.schedule))],
      ));
    }
    res.status(201).json(created);
  }));

  router.put('/subjects/:id', wrap(async (req, res) => {
    const { name, color, teacher, room, schedule } = req.body || {};
    const row = await one(
      `UPDATE subjects SET name = COALESCE($1, name), color = COALESCE($2, color),
         teacher = COALESCE($3, teacher), room = COALESCE($4, room), schedule = COALESCE($5, schedule)
       WHERE id = $6 AND user_id = $7 RETURNING *`,
      [clean(name), color ?? null, clean(teacher), clean(room),
        schedule === undefined ? null : JSON.stringify(cleanSchedule(schedule)), req.params.id, req.userId],
    );
    if (!row) return res.status(404).json({ error: 'subject not found' });
    res.json(row);
  }));

  // Notes, materials and the events tied to a subject cascade with it (schema.sql).
  router.delete('/subjects/:id', wrap(async (req, res) => {
    const rows = await q('DELETE FROM subjects WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (!rows.length) return res.status(404).json({ error: 'subject not found' });
    res.json({ deleted: true });
  }));

  return router;
};
