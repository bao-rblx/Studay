const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setup } = require('./helpers');

const NOTE_TEXT = 'Photosynthesis converts light energy into chemical energy. '
  + 'Chlorophyll absorbs mostly blue and red light in the leaves. '
  + 'The process releases oxygen as a by-product into the atmosphere. '
  + 'Glucose produced by photosynthesis fuels cellular respiration.';

let app;
before(async () => { ({ app } = await setup()); });

test('GET /api/health reports the database as up', async () => {
  const res = await request(app).get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.db, 'up');
});

test('subjects: create, list, update, delete', async () => {
  const created = await request(app).post('/api/subjects').send({ name: 'Biology', color: '#00aa00' });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, 'Biology');

  const list = await request(app).get('/api/subjects');
  assert.ok(list.body.some((s) => s.id === created.body.id));

  const updated = await request(app).put(`/api/subjects/${created.body.id}`).send({ name: 'Bio' });
  assert.equal(updated.body.name, 'Bio');
  assert.equal(updated.body.color, '#00aa00');

  const del = await request(app).delete(`/api/subjects/${created.body.id}`);
  assert.equal(del.status, 200);
  assert.equal((await request(app).delete(`/api/subjects/${created.body.id}`)).status, 404);
});

test('subjects: name is required', async () => {
  const res = await request(app).post('/api/subjects').send({ name: '  ' });
  assert.equal(res.status, 400);
});

test('notes, materials and events cascade when the subject is deleted', async () => {
  const subject = (await request(app).post('/api/subjects').send({ name: 'Chemistry' })).body;
  const note = await request(app).post('/api/notes').send({ subject_id: subject.id, title: 'Atoms', content: NOTE_TEXT });
  assert.equal(note.status, 201);
  const mat = await request(app).post('/api/materials').send({ subject_id: subject.id, title: 'Slides', content: NOTE_TEXT });
  assert.equal(mat.status, 201);
  const ev = await request(app).post('/api/events').send({ title: 'Lab', event_date: '2025-11-10', subject_id: subject.id });
  assert.equal(ev.status, 201);

  await request(app).delete(`/api/subjects/${subject.id}`);
  assert.equal((await request(app).get(`/api/notes?subject_id=${subject.id}`)).body.length, 0);
  assert.equal((await request(app).get(`/api/materials?subject_id=${subject.id}`)).body.length, 0);
  assert.ok(!(await request(app).get('/api/events')).body.some((e) => e.id === ev.body.id));
});

test('subjects: timetable fields and bulk create', async () => {
  const res = await request(app).post('/api/subjects/bulk').send({ subjects: [
    { name: 'Databases', teacher: 'Dr. Lan', schedule: [{ day: 1, start: '07:30', end: '09:30' }, { day: 8 }] },
    { name: 'Networks' },
  ] });
  assert.equal(res.status, 201);
  assert.equal(res.body.length, 2);
  assert.equal(res.body[0].teacher, 'Dr. Lan');
  assert.deepEqual(res.body[0].schedule, [{ day: 1, start: '07:30', end: '09:30', room: null }]);
  assert.equal((await request(app).post('/api/subjects/bulk').send({ subjects: [{ name: '' }] })).status, 400);
  assert.equal((await request(app).post('/api/subjects/bulk').send({})).status, 400);
});

test('events: create, range query, mark done, validation', async () => {
  const created = await request(app).post('/api/events').send({ title: 'Presentation', kind: 'presentation', event_date: '2025-12-01', start_time: '09:00' });
  assert.equal(created.status, 201);
  assert.equal(created.body.event_date, '2025-12-01');

  const inRange = await request(app).get('/api/events?from=2025-12-01&to=2025-12-31');
  assert.ok(inRange.body.some((e) => e.id === created.body.id));
  const outRange = await request(app).get('/api/events?from=2026-01-01&to=2026-01-31');
  assert.ok(!outRange.body.some((e) => e.id === created.body.id));

  const done = await request(app).put(`/api/events/${created.body.id}`).send({ done: true });
  assert.equal(done.body.done, true);
  assert.equal(done.body.title, 'Presentation');

  assert.equal((await request(app).post('/api/events').send({ title: 'x', event_date: '01/12/2025' })).status, 400);
  assert.equal((await request(app).post('/api/events').send({ title: 'x', event_date: '2025-12-01', start_time: '9am' })).status, 400);
  assert.equal((await request(app).get('/api/events?from=bad&to=2025-12-01')).status, 400);
  assert.equal((await request(app).delete(`/api/events/${created.body.id}`)).status, 200);
  assert.equal((await request(app).delete(`/api/events/${created.body.id}`)).status, 404);
});

test('flashcards endpoint is gone', async () => {
  assert.equal((await request(app).get('/api/flashcards')).status, 404);
});

test('notes: missing fields and unknown subject are rejected with 400', async () => {
  assert.equal((await request(app).post('/api/notes').send({ title: 'x' })).status, 400);
  const res = await request(app).post('/api/notes').send({ subject_id: 99999, title: 't', content: 'c' });
  assert.equal(res.status, 400);
});

test('invalid id returns 400, not 500', async () => {
  const res = await request(app).put('/api/notes/abc').send({ title: 'x' });
  assert.equal(res.status, 400);
});

test('AI: generates study aids from pasted text', async () => {
  const res = await request(app).post('/api/ai/generate').send({ content: NOTE_TEXT });
  assert.equal(res.status, 200);
  assert.ok(res.body.summary.summary.length > 0);
  assert.ok(res.body.quiz.length > 0);
  assert.equal(res.body.flashcards, undefined);
});

test('AI quick note proposes an event without saving it', async () => {
  const before = (await request(app).get('/api/events')).body.length;
  const res = await request(app).post('/api/ai/quick-note').send({ text: 'present databases next week', today: '2025-11-05' });
  assert.equal(res.status, 200);
  assert.equal(res.body.event.kind, 'presentation');
  assert.equal(res.body.event.event_date, '2025-11-10');
  assert.equal((await request(app).get('/api/events')).body.length, before);
  assert.equal((await request(app).post('/api/ai/quick-note').send({ text: ' ' })).status, 400);
});

test('AI uploads are validated', async () => {
  const bad = await request(app).post('/api/ai/scan-timetable').send({ file: { mime_type: 'text/html', data: 'AAAA' } });
  assert.equal(bad.status, 400);
  const pdf = await request(app).post('/api/ai/scan-timetable').send({ file: { mime_type: 'application/pdf', data: 'AAAA' } });
  assert.equal(pdf.status, 400);
  const notB64 = await request(app).post('/api/ai/read-material').send({ file: { mime_type: 'image/png', data: '<script>' } });
  assert.equal(notB64.status, 400);
  const ok = await request(app).post('/api/ai/scan-timetable').send({ file: { mime_type: 'image/png', data: 'AAAA' } });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.subjects));
});

test('AI read material, ask and quiz use saved study material', async () => {
  const subject = (await request(app).post('/api/subjects').send({ name: 'Biology' })).body;
  const read = await request(app).post('/api/ai/read-material').send({ text: NOTE_TEXT, filename: 'week1.txt' });
  assert.equal(read.status, 200);
  assert.ok(read.body.summary);
  await request(app).post('/api/materials').send({ subject_id: subject.id, title: read.body.title, content: read.body.content, summary: read.body.summary });

  const ask = await request(app).post('/api/ai/ask').send({ question: 'What does chlorophyll absorb?', subject_id: subject.id });
  assert.equal(ask.status, 200);
  assert.match(ask.body.answer, /Chlorophyll/);
  assert.equal((await request(app).post('/api/ai/ask').send({})).status, 400);

  const quiz = await request(app).post('/api/ai/quiz').send({ subject_id: subject.id });
  assert.equal(quiz.status, 200);
  assert.ok(quiz.body.quiz.length > 0);
  const empty = (await request(app).post('/api/subjects').send({ name: 'Empty' })).body;
  assert.equal((await request(app).post('/api/ai/quiz').send({ subject_id: empty.id })).status, 400);
});

test('AI: too-short text and unknown note are rejected', async () => {
  assert.equal((await request(app).post('/api/ai/generate').send({ content: 'short' })).status, 400);
  assert.equal((await request(app).post('/api/ai/generate').send({ note_id: 424242 })).status, 404);
});

test('unknown API route returns JSON 404', async () => {
  const res = await request(app).get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'unknown endpoint');
});

test('database down: API answers 503 instead of crashing', async () => {
  const { createApp } = require('../src/app');
  const down = { query: async () => { const e = new Error('connect ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; } };
  const broken = createApp({ pool: down });
  const health = await request(broken).get('/api/health');
  assert.equal(health.status, 503);
  const list = await request(broken).get('/api/subjects');
  assert.equal(list.status, 503);
  assert.equal(list.headers['retry-after'], '10');
});
