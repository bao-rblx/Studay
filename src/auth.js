// Accounts, sessions and the auth middleware.
// Nothing is added to package.json: node:crypto covers both password hashing (scrypt)
// and the session token, and the cookie is written by hand (a few attributes, no parser
// dependency needed).
const crypto = require('crypto');
const { isDbDown } = require('./db');

const COOKIE = 'studay_session';
const SESSION_DAYS = 30;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const KEY_BYTES = 64;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Passwords are stored as scrypt$<salt>$<hash>: the scheme is part of the value so a
// future upgrade can verify old rows before rehashing them.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, KEY_BYTES).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const newToken = () => crypto.randomBytes(32).toString('base64url');
// Only the hash reaches the database, so a dump cannot be replayed as a live session.
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const name = part.slice(0, i).trim();
    if (!name) return;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[name] = part.slice(i + 1).trim();
    }
  });
  return out;
}

// HttpOnly keeps the token away from page scripts; SameSite=Lax stops cross-site POSTs
// from using the cookie, which is the CSRF protection this app needs.
function cookieAttrs(req) {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, token) {
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`);
}

function clearSessionCookie(req, res) {
  res.append('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`);
}

async function createSession(pool, req, res, userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash(token), userId, expiresAt]);
  // Housekeeping on the login path only: an expired row is useless, so drop it now
  // instead of paying for a background job.
  await pool.query('DELETE FROM sessions WHERE expires_at < $1', [new Date()]);
  setSessionCookie(req, res, token);
  return token;
}

async function destroySession(pool, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash(token)]);
  clearSessionCookie(req, res);
}

// Resolves the cookie into req.userId / req.user. Never fails the request: an unknown,
// expired or unreadable session is simply "signed out". A database outage is different,
// so it is forwarded to the error middleware (which answers 503).
function attachUser(pool) {
  return async (req, res, next) => {
    req.userId = null;
    req.user = null;
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next();
    try {
      const { rows } = await pool.query(
        `SELECT s.user_id, s.expires_at, u.email, u.display_name
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1`,
        [tokenHash(token)],
      );
      const row = rows[0];
      // Expiry is compared in JS so no database time function is involved.
      if (row && new Date(row.expires_at).getTime() > Date.now()) {
        req.userId = row.user_id;
        req.user = { id: row.user_id, email: row.email, display_name: row.display_name || null };
      }
    } catch (err) {
      if (isDbDown(err)) return next(err);
      console.warn('[auth] session lookup failed:', err.message);
    }
    return next();
  };
}

const requireUser = (req, res, next) => (req.userId ? next() : res.status(401).json({ error: 'please sign in' }));

// Returns a normalised email or null. Emails are stored lowercase so uniqueness is real.
function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return EMAIL_RE.test(email) && email.length <= 254 ? email : null;
}

function passwordProblem(password) {
  const pwd = String(password || '');
  if (pwd.length < PASSWORD_MIN) return `password must be at least ${PASSWORD_MIN} characters`;
  if (pwd.length > PASSWORD_MAX) return `password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

module.exports = {
  COOKIE,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  parseCookies,
  createSession,
  destroySession,
  attachUser,
  requireUser,
  cleanEmail,
  passwordProblem,
  tokenHash,
  newToken,
};
