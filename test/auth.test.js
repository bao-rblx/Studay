const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { setup, setupWithUser, request } = require('./helpers');

let agent;
before(async () => { ({ agent } = await setupWithUser()); });

test('anonymous requests are rejected with 401', async () => {
  const { app } = await setup();
  for (const path of ['/api/subjects', '/api/notes', '/api/events', '/api/materials', '/api/auth/me']) {
    const res = await request(app).get(path);
    assert.equal(res.status, 401, `${path} should need a session`);
  }
  // The health check stays public so a platform can poll it.
  assert.equal((await request(app).get('/api/health')).status, 200);
});

test('register validates the email and the password', async () => {
  const { app } = await setup();
  const post = (body) => request(app).post('/api/auth/register').send(body);
  assert.equal((await post({ email: 'nope', password: 'password123' })).status, 400);
  assert.equal((await post({ email: 'a@b.co', password: 'short' })).status, 400);
  assert.equal((await post({ email: '', password: 'password123' })).status, 400);
});

test('register signs the account in and returns it', async () => {
  const { app } = await setup();
  const reg = await request(app).post('/api/auth/register')
    .send({ email: 'Mai@Example.com', password: 'password123', display_name: 'Mai' });
  assert.equal(reg.status, 201);
  assert.equal(reg.body.user.email, 'mai@example.com');
  assert.equal(reg.body.user.display_name, 'Mai');
  const cookie = String(reg.headers['set-cookie']);
  assert.match(cookie, /studay_session=/);
  assert.match(cookie, /HttpOnly/);
  // The same email cannot be registered twice.
  assert.equal((await request(app).post('/api/auth/register')
    .send({ email: 'mai@example.com', password: 'password123' })).status, 409);
  const me = await request.agent(app).get('/api/auth/me');
  assert.equal(me.status, 401);
});

test('login accepts any email casing and rejects a wrong password', async () => {
  const { app } = await setup();
  await request(app).post('/api/auth/register').send({ email: 'lan@example.com', password: 'password123' });
  const wrong = await request(app).post('/api/auth/login').send({ email: 'lan@example.com', password: 'password124' });
  assert.equal(wrong.status, 401);
  const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'password123' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.body.error, unknown.body.error, 'the message must not reveal which emails exist');
  const ok = await request(app).post('/api/auth/login').send({ email: 'LAN@example.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['set-cookie']), /studay_session=/);
});

test('logout drops the session cookie and the server-side row', async () => {
  const { app } = await setup();
  const agent2 = request.agent(app);
  await agent2.post('/api/auth/register').send({ email: 'out@example.com', password: 'password123' });
  assert.equal((await agent2.get('/api/subjects')).status, 200);
  assert.equal((await agent2.post('/api/auth/logout')).status, 200);
  assert.equal((await agent2.get('/api/subjects')).status, 401);
});

test('two accounts never see each other\'s data', async () => {
  const { app } = await setup();
  const a = request.agent(app);
  const b = request.agent(app);
  await a.post('/api/auth/register').send({ email: 'a@example.com', password: 'password123' });
  await b.post('/api/auth/register').send({ email: 'b@example.com', password: 'password123' });

  const subject = (await a.post('/api/subjects').send({ name: 'Biology' })).body;
  const note = (await a.post('/api/notes').send({ subject_id: subject.id, title: 'Cells', content: 'All living things are made of cells.' })).body;
  await a.post('/api/events').send({ title: 'Exam', event_date: '2026-11-09' });

  assert.equal((await b.get('/api/subjects')).body.length, 0);
  assert.equal((await b.get('/api/notes')).body.length, 0);
  assert.equal((await b.get('/api/events')).body.length, 0);
  // B cannot reach A's records by guessing their ids.
  assert.equal((await b.delete(`/api/notes/${note.id}`)).status, 404);
  assert.equal((await b.put(`/api/subjects/${subject.id}`).send({ name: 'Hijacked' })).status, 404);
  assert.equal((await b.post('/api/notes').send({ subject_id: subject.id, title: 'x', content: 'y' })).status, 400);
  // ...while A still owns them.
  assert.equal((await a.get('/api/subjects')).body.length, 1);
});

test('the first account claims data created before accounts existed', async () => {
  const { pool, app } = await setup();
  await pool.query(`INSERT INTO subjects (name, color) VALUES ('Legacy subject', '#007aff')`);
  const first = request.agent(app);
  const reg = await first.post('/api/auth/register').send({ email: 'first@example.com', password: 'password123' });
  assert.equal(reg.body.claimed_legacy_data, true);
  const list = await first.get('/api/subjects');
  assert.deepEqual(list.body.map((s) => s.name), ['Legacy subject']);
  // The second account does not inherit anything.
  const second = request.agent(app);
  await second.post('/api/auth/register').send({ email: 'second@example.com', password: 'password123' });
  assert.equal((await second.get('/api/subjects')).body.length, 0);
});

test('changing the password needs the current one', async () => {
  const { app } = await setup();
  const agent3 = request.agent(app);
  await agent3.post('/api/auth/register').send({ email: 'pwd@example.com', password: 'password123' });
  assert.equal((await agent3.put('/api/auth/me').send({ new_password: 'password456', current_password: 'nope' })).status, 403);
  assert.equal((await agent3.put('/api/auth/me').send({ new_password: 'password456', current_password: 'password123' })).status, 200);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'pwd@example.com', password: 'password123' })).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'pwd@example.com', password: 'password456' })).status, 200);
});

test('display name can be updated', async () => {
  const res = await agent.put('/api/auth/me').send({ display_name: 'Dot Two' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.display_name, 'Dot Two');
});

test('passwords are stored as salted scrypt hashes, never in clear text', async () => {
  const { pool, app } = await setup();
  await request(app).post('/api/auth/register').send({ email: 'leak@example.com', password: 'password123' });
  const rows = (await pool.query('SELECT email, password_hash FROM users')).rows;
  assert.equal(rows.length, 1);
  assert.ok(rows[0].password_hash.startsWith('scrypt$'));
  assert.ok(!rows[0].password_hash.includes('password123'));
});
