// Auth endpoints: register, sign in, sign out, read/update the current account.
const express = require('express');
const {
  hashPassword, verifyPassword, createSession, destroySession,
  cleanEmail, passwordProblem, requireUser,
} = require('../auth');
const { wrap } = require('../lib/helpers');

// Tables whose legacy rows (created before accounts) the first account inherits.
const OWNED_TABLES = ['subjects', 'notes', 'events', 'materials'];

module.exports = ({ pool, one }) => {
  const router = express.Router();
  const publicUser = (row) => (row ? { id: row.id, email: row.email, display_name: row.display_name || null } : null);

  router.post('/register', wrap(async (req, res) => {
    const { email, password, display_name } = req.body || {};
    const mail = cleanEmail(email);
    if (!mail) return res.status(400).json({ error: 'a valid email is required' });
    const bad = passwordProblem(password);
    if (bad) return res.status(400).json({ error: bad });
    if (await one('SELECT id FROM users WHERE email = $1', [mail])) {
      return res.status(409).json({ error: 'that email is already registered' });
    }

    // Was the database empty before this account? Then any row without an owner is this
    // person's old single-user data and should follow them into the account.
    const firstEver = !(await one('SELECT id FROM users LIMIT 1'));
    const created = await one(
      'INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, display_name',
      [mail, String(display_name || '').trim().slice(0, 80) || null, hashPassword(password)],
    );
    if (firstEver) {
      for (const table of OWNED_TABLES) {
        await pool.query(`UPDATE ${table} SET user_id = $1 WHERE user_id IS NULL`, [created.id]);
      }
    }
    await createSession(pool, req, res, created.id);
    res.status(201).json({ user: publicUser(created), claimed_legacy_data: firstEver });
  }));

  router.post('/login', wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const mail = cleanEmail(email);
    // One message for both cases: never reveal which emails exist.
    const denied = () => res.status(401).json({ error: 'wrong email or password' });
    if (!mail || !password) return denied();
    const user = await one('SELECT id, email, display_name, password_hash FROM users WHERE email = $1', [mail]);
    if (!user || !verifyPassword(password, user.password_hash)) return denied();
    await createSession(pool, req, res, user.id);
    res.json({ user: publicUser(user), claimed_legacy_data: false });
  }));

  router.post('/logout', wrap(async (req, res) => {
    await destroySession(pool, req, res);
    res.json({ ok: true });
  }));

  router.get('/me', requireUser, (req, res) => res.json({ user: req.user }));

  // Rename the account, and/or change the password (which needs the current one).
  router.put('/me', requireUser, wrap(async (req, res) => {
    const { display_name, current_password, new_password } = req.body || {};
    const patch = [];
    const params = [];
    if (display_name !== undefined) {
      params.push(String(display_name).trim().slice(0, 80) || null);
      patch.push(`display_name = $${params.length}`);
    }
    if (new_password !== undefined) {
      const bad = passwordProblem(new_password);
      if (bad) return res.status(400).json({ error: bad });
      const row = await one('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
      if (!verifyPassword(current_password, row.password_hash)) {
        return res.status(403).json({ error: 'current password is wrong' });
      }
      params.push(hashPassword(new_password));
      patch.push(`password_hash = $${params.length}`);
    }
    if (!patch.length) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.userId);
    const updated = await one(
      `UPDATE users SET ${patch.join(', ')} WHERE id = $${params.length} RETURNING id, email, display_name`,
      params,
    );
    res.json({ user: publicUser(updated) });
  }));

  // Account removal: drops the sessions and the rows this account owns, in one place.
  router.delete('/me', requireUser, wrap(async (req, res) => {
    for (const table of ['notes', 'materials', 'events', 'subjects']) {
      await pool.query(`DELETE FROM ${table} WHERE user_id = $1`, [req.userId]);
    }
    await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);
    destroySession(pool, req, res).catch(() => {});
    res.json({ deleted: true });
  }));

  return router;
};
