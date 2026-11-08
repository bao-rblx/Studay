// Global search: one UNION ALL query over the four searchable tables.
// Pure builder - no Express, no database access - so the SQL shape can be unit tested.
//
// buildSearch() returns { sql, params } on success, or
// { sql: null, params: [], error } when the query is too short or too long.
//
// Every result row has the same shape, whatever table it came from:
//   type          'subject' | 'note' | 'material' | 'event'
//   id            row id inside that table
//   title         the text the user searched against
//   subtitle      one short context line: teacher + room, subject name, event kind
//   subject_id    subject the row belongs to (its own id for a subject row)
//   subject_name  name of that subject, null when the row has none
//   event_date    'YYYY-MM-DD' for events, null otherwise
//   rank          1 exact, 2 prefix, 3 word start, 4 contains, 5 filename only

const MIN_QUERY = 2;
const MAX_QUERY = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Escape the LIKE wildcards (and the escape character itself) so a query such as
// '100%' matches that literal text instead of turning into a wildcard.
function escapeLike(v) {
  return String(v ?? '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Ranking CASE for one text column. $2..$5 are the four patterns built in buildSearch().
// A leading space in the word-start pattern ('% term%') is enough: it catches every word
// that does not start the title, which is all the ordering needs.
const rankCase = (col) => `CASE
         WHEN LOWER(${col}) = LOWER($2) THEN 1
         WHEN ${col} ILIKE $3 THEN 2
         WHEN ${col} ILIKE $4 THEN 3
         WHEN ${col} ILIKE $5 THEN 4
         ELSE 5
       END`;

// "teacher · room" without TRIM/NULLIF: pg-mem implements very few text functions,
// and the tests run the same SQL against it.
const joined = (a, b) => `CASE
         WHEN ${a} IS NULL AND ${b} IS NULL THEN NULL
         WHEN ${a} IS NULL THEN ${b}
         WHEN ${b} IS NULL THEN ${a}
         ELSE ${a} || ' \u00b7 ' || ${b}
       END`;

// Keep the LIMIT a plain integer so both PostgreSQL and pg-mem accept it as a literal.
function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

// `userId` comes from the session; every branch filters on it, so a user can never
// see another user's rows. A missing id yields null and therefore no rows at all.
function buildSearch({ q, userId, limit = DEFAULT_LIMIT } = {}) {
  const term = String(q ?? '').trim();
  if (term.length < MIN_QUERY) {
    return { sql: null, params: [], error: `search needs at least ${MIN_QUERY} characters` };
  }
  if (term.length > MAX_QUERY) {
    return { sql: null, params: [], error: `search is too long (max ${MAX_QUERY} characters)` };
  }

  // $1 user, $2 raw term (exact match), $3 prefix, $4 word start, $5 contains.
  const pattern = escapeLike(term);
  const params = [userId, term, `${pattern}%`, `% ${pattern}%`, `%${pattern}%`];

  const union = `
    SELECT 'subject' AS type, s.id AS id, s.name AS title,
      ${joined('s.teacher', 's.room')} AS subtitle,
      s.id AS subject_id, s.name AS subject_name, NULL AS event_date,
      ${rankCase('s.name')} AS rank
    FROM subjects s
    WHERE s.user_id = $1 AND s.name ILIKE $5
    UNION ALL
    SELECT 'note' AS type, n.id AS id, n.title AS title, sub.name AS subtitle,
      n.subject_id AS subject_id, sub.name AS subject_name, NULL AS event_date,
      ${rankCase('n.title')} AS rank
    FROM notes n JOIN subjects sub ON sub.id = n.subject_id
    WHERE n.user_id = $1 AND n.title ILIKE $5
    UNION ALL
    SELECT 'material' AS type, m.id AS id, m.title AS title,
      CASE WHEN m.filename IS NULL OR m.filename = '' THEN sub.name ELSE m.filename END AS subtitle,
      m.subject_id AS subject_id, sub.name AS subject_name, NULL AS event_date,
      ${rankCase('m.title')} AS rank
    FROM materials m JOIN subjects sub ON sub.id = m.subject_id
    WHERE m.user_id = $1 AND (m.title ILIKE $5 OR m.filename ILIKE $5)
    UNION ALL
    SELECT 'event' AS type, e.id AS id, e.title AS title, e.kind AS subtitle,
      e.subject_id AS subject_id, sub.name AS subject_name, e.event_date AS event_date,
      ${rankCase('e.title')} AS rank
    FROM events e LEFT JOIN subjects sub ON sub.id = e.subject_id
    WHERE e.user_id = $1 AND e.title ILIKE $5`;

  // Sort and limit outside the UNION: PostgreSQL would accept the ORDER BY inside it,
  // but pg-mem (used by the tests) silently ignores that, and the outer select is the
  // same plan for PostgreSQL anyway.
  const sql = `SELECT * FROM (${union}
    ) AS hits ORDER BY rank, type, id DESC LIMIT ${clampLimit(limit)}`;

  return { sql, params };
}

module.exports = { MIN_QUERY, MAX_QUERY, DEFAULT_LIMIT, MAX_LIMIT, buildSearch, escapeLike };
