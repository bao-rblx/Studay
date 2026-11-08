// Global search endpoint: one query over subjects, notes, materials and events.
// The SQL itself lives in src/search.js so the ranking rules stay unit-testable.
const express = require('express');
const { wrap } = require('../lib/helpers');
const { buildSearch } = require('../search');

// pg-mem (used by the tests) hands back a Date for a DATE column; the API always
// sends 'YYYY-MM-DD', like the events routes do.
const isoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);

module.exports = ({ q }) => {
  const router = express.Router();

  // req.userId is always a real account id here: app.js mounts requireUser first.
  // buildSearch caps the result at 20 rows and rejects anything shorter than 2 characters.
  router.get('/search', wrap(async (req, res) => {
    const query = String(req.query.q ?? '').trim();
    const { sql, params, error } = buildSearch({ q: query, userId: req.userId });
    if (error) return res.status(400).json({ error });
    const results = await q(sql, params);
    res.json({ query, results: results.map((row) => ({ ...row, event_date: isoDate(row.event_date) })) });
  }));

  return router;
};
