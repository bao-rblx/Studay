// GET /api/search: the global name search, end to end through the real routes.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setupWithUser, request } = require('./helpers');

let agent, app;
before(async () => { ({ agent, app } = await setupWithUser()); });

const search = (q) => agent.get('/api/search').query({ q });
const makeSubject = async (name) => (await agent.post('/api/subjects').send({ name })).body;

test('finds subjects, notes, files and events by name', async () => {
  const subject = await makeSubject('Astrophysics');
  await agent.post('/api/notes').send({ subject_id: subject.id, title: 'Astrophysics chapter 1', content: 'Stars.' });
  await agent.post('/api/materials')
    .send({ subject_id: subject.id, title: 'Astrophysics slides', filename: 'wk1.pdf', content: 'Slides.' });
  await agent.post('/api/events')
    .send({ title: 'Astrophysics exam', event_date: '2026-03-04', subject_id: subject.id });

  const res = await search('astrophysics');
  assert.equal(res.status, 200);
  assert.equal(res.body.query, 'astrophysics');
  const types = new Set(res.body.results.map((r) => r.type));
  assert.deepEqual([...types].sort(), ['event', 'material', 'note', 'subject']);
  for (const row of res.body.results) {
    assert.deepEqual(Object.keys(row).sort(),
      ['event_date', 'id', 'rank', 'subject_id', 'subject_name', 'subtitle', 'title', 'type']);
  }
  // The row carries the subject it belongs to, so the UI can show context.
  const note = res.body.results.find((r) => r.type === 'note');
  assert.equal(note.subject_id, subject.id);
  assert.equal(note.subject_name, 'Astrophysics');
});

test('an exact name ranks above a prefix match', async () => {
  await makeSubject('Nebula Studies');
  const exact = await makeSubject('Nebula');
  const res = await search('nebula');
  assert.equal(res.body.results[0].id, exact.id);
  assert.equal(res.body.results[0].title, 'Nebula');
});

test('matches on a material filename as well as its title', async () => {
  const subject = await makeSubject('Marine Biology');
  const mat = (await agent.post('/api/materials')
    .send({ subject_id: subject.id, title: 'Week 1 slides', filename: 'zebrafish-lab.pdf', content: 'Fish.' })).body;
  const res = await search('zebrafish');
  const hit = res.body.results.find((r) => r.type === 'material');
  assert.equal(hit.id, mat.id);
  assert.equal(hit.subtitle, 'zebrafish-lab.pdf');
});

test('event dates are sent as YYYY-MM-DD, not timestamps', async () => {
  await agent.post('/api/events').send({ title: 'Isotope deadline', event_date: '2026-05-06' });
  const res = await search('isotope');
  const hit = res.body.results.find((r) => r.type === 'event');
  assert.equal(hit.event_date, '2026-05-06');
});

test('a query that is too short or missing is a 400 with a readable message', async () => {
  for (const q of ['a', '', '%']) {
    const res = await search(q);
    assert.equal(res.status, 400, `"${q}" should be rejected`);
    assert.match(res.body.error, /at least 2 characters/);
  }
  assert.equal((await agent.get('/api/search')).status, 400);
});

test('an over-long query is a 400 too', async () => {
  const res = await search('a'.repeat(101));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /max 100 characters/);
});

test('another account never sees this account\'s records', async () => {
  const mine = await makeSubject('Trombone Practice');
  assert.ok(mine.id);
  // A second account on the same database: its search must come back empty.
  const other = request.agent(app);
  const reg = await other.post('/api/auth/register')
    .send({ email: 'other@example.com', password: 'password123', display_name: 'Other' });
  assert.equal(reg.status, 201);
  assert.deepEqual((await other.get('/api/search').query({ q: 'trombone' })).body.results, []);
  // ...and what the other account creates stays invisible here.
  await other.post('/api/subjects').send({ name: 'Xylophone Basics' });
  assert.deepEqual((await search('xylophone')).body.results, []);
  assert.equal((await other.get('/api/search').query({ q: 'xylophone' })).body.results.length, 1);
});

test('at most 20 results come back', async () => {
  for (let i = 1; i <= 25; i++) await makeSubject(`Quantum Physics ${i}`);
  const res = await search('quantum');
  assert.equal(res.body.results.length, 20);
  assert.ok(res.body.results.every((r) => r.type === 'subject'));
});

test('search needs a session', async () => {
  const res = await request(app).get('/api/search').query({ q: 'algebra' });
  assert.equal(res.status, 401);
});
