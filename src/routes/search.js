// Global search endpoint. Placeholder: the search wave replaces the body of this file
// with src/search.js (one UNION query over subjects, notes, materials and events).
const express = require('express');
const { wrap } = require('../lib/helpers');

module.exports = () => {
  const router = express.Router();
  router.get('/search', wrap(async (req, res) => {
    res.status(501).json({ error: 'search is not available yet', query: String(req.query.q || '') });
  }));
  return router;
};
