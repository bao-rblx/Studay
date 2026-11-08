// Express application: REST API + static frontend.
// The pool is injected so the tests can run against an in-memory Postgres, and `ai` is
// injectable so tests never call the real Gemini API.
//
// Route modules receive a shared context:
//   { pool, q, one, AI, subjectExists(userId, id), wrap, H }
// and must scope every query with req.userId (set by the auth middleware below).
const path = require('path');
const express = require('express');
const defaultAi = require('../ai');
const { isDbDown } = require('./db');
const H = require('./lib/helpers');
const { attachUser, requireUser } = require('./auth');

const authRoutes = require('./routes/auth');
const subjectsRoutes = require('./routes/subjects');
const notesRoutes = require('./routes/notes');
const eventsRoutes = require('./routes/events');
const materialsRoutes = require('./routes/materials');
const aiRoutes = require('./routes/ai');
const quizRoutes = require('./routes/quiz');
const searchRoutes = require('./routes/search');

function createApp({ pool, ai = {} }) {
  const AI = { ...defaultAi, ...(typeof ai === 'function' ? { generateStudyAids: ai } : ai) };
  const app = express();
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  // Ownership check used by every route that references a subject.
  const subjectExists = async (userId, id) => H.isId(id)
    && Boolean(await one('SELECT id FROM subjects WHERE id = $1 AND user_id = $2', [id, userId]));
  const ctx = { pool, q, one, AI, subjectExists, wrap: H.wrap, H };

  app.disable('x-powered-by');
  // AI routes accept base64 images/PDFs; everything else keeps a small limit.
  // The first parser that reads the body wins, so the larger one must come first.
  app.use('/api/ai', express.json({ limit: '15mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Health check stays public: Render and CI poll it without a session.
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'up' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  // Turn the session cookie into req.userId / req.user for everything under /api.
  app.use('/api', attachUser(pool));
  // Sign up / sign in / sign out must work without a session.
  app.use('/api/auth', authRoutes(ctx));
  // Everything below this line belongs to one signed-in account.
  app.use('/api', requireUser);

  app.use('/api', subjectsRoutes(ctx));
  app.use('/api', notesRoutes(ctx));
  app.use('/api', eventsRoutes(ctx));
  app.use('/api', materialsRoutes(ctx));
  app.use('/api', aiRoutes(ctx));
  app.use('/api', quizRoutes(ctx));
  app.use('/api', searchRoutes(ctx));

  app.use('/api', (req, res) => res.status(404).json({ error: 'unknown endpoint' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
    if (err.code === '22P02' || err.code === '22007' || err.code === '22008') return res.status(400).json({ error: 'invalid value' });
    if (err.code === '23503') return res.status(400).json({ error: 'referenced record does not exist' });
    if (isDbDown(err)) {
      console.warn('[db] request failed, database unreachable:', err.code || err.message);
      return res.status(503).set('Retry-After', '10').json({ error: 'database is waking up - try again in a few seconds' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
