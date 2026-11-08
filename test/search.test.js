// Unit tests for the pure search query builder: no database, just the SQL and its params.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSearch, escapeLike, MIN_QUERY, MAX_QUERY, DEFAULT_LIMIT, MAX_LIMIT,
} = require('../src/search');

const TYPES = ['subject', 'note', 'material', 'event'];
const limitOf = (sql) => Number(sql.match(/LIMIT (\d+)\s*$/)[1]);

test('builds one UNION ALL over the four searchable tables', () => {
  const { sql } = buildSearch({ q: 'algebra', userId: 1 });
  assert.equal((sql.match(/UNION ALL/g) || []).length, 3);
  for (const type of TYPES) assert.ok(sql.includes(`'${type}' AS type`), `missing ${type} branch`);
});

test('binds the user id and the four match patterns', () => {
  const { params } = buildSearch({ q: 'algebra', userId: 7 });
  assert.deepEqual(params, [7, 'algebra', 'algebra%', '% algebra%', '%algebra%']);
});

test('every branch is restricted to the signed-in user', () => {
  const { sql } = buildSearch({ q: 'algebra', userId: 7 });
  assert.equal((sql.match(/user_id = \$1/g) || []).length, TYPES.length);
});

test('trims the query before matching', () => {
  const padded = buildSearch({ q: '  algebra  ', userId: 1 });
  const clean = buildSearch({ q: 'algebra', userId: 1 });
  assert.deepEqual(padded.params, clean.params);
});

test('escapes LIKE wildcards in the query', () => {
  assert.equal(escapeLike('%'), '\\%');
  assert.equal(escapeLike('_'), '\\_');
  assert.equal(escapeLike('\\'), '\\\\');
  assert.equal(escapeLike('100% pass'), '100\\% pass');

  const { params } = buildSearch({ q: '100%', userId: 1 });
  assert.equal(params[2], '100\\%%');
  assert.equal(params[4], '%100\\%%');
});

test('a query made of wildcards cannot widen the match', () => {
  const { params } = buildSearch({ q: '%%', userId: 1 });
  // Both '%' are escaped, so the pattern only matches a literal '%%' in a title.
  assert.equal(params[4], '%\\%\\%%');
  // No pattern may collapse into "match everything".
  for (const pattern of params.slice(2)) assert.notEqual(pattern, '%%');
});

test('rejects a query that is too short', () => {
  for (const q of ['', ' ', 'a', undefined, null]) {
    const out = buildSearch({ q, userId: 1 });
    assert.equal(out.sql, null);
    assert.deepEqual(out.params, []);
    assert.match(out.error, new RegExp(`at least ${MIN_QUERY} characters`));
  }
});

test('accepts the shortest query and rejects one over the length limit', () => {
  assert.ok(buildSearch({ q: 'ab', userId: 1 }).sql, `a ${MIN_QUERY}-character query is enough`);
  assert.ok(buildSearch({ q: 'a'.repeat(MAX_QUERY), userId: 1 }).sql);
  const tooLong = buildSearch({ q: 'a'.repeat(MAX_QUERY + 1), userId: 1 });
  assert.equal(tooLong.sql, null);
  assert.match(tooLong.error, new RegExp(`max ${MAX_QUERY} characters`));
});

test('clamps the limit to 1..50 and defaults to 20', () => {
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1 }).sql), DEFAULT_LIMIT);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: 1 }).sql), 1);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: 0 }).sql), 1);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: -5 }).sql), 1);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: 500 }).sql), MAX_LIMIT);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: 7.8 }).sql), 7);
  assert.equal(limitOf(buildSearch({ q: 'algebra', userId: 1, limit: 'nonsense' }).sql), DEFAULT_LIMIT);
});

test('orders by rank, then type, then newest id', () => {
  const { sql } = buildSearch({ q: 'algebra', userId: 1 });
  assert.ok(sql.includes('ORDER BY rank, type, id DESC'));
});
