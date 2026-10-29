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
  assert.equal(created.status, 200);
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

test('notes and flashcards cascade when the subject is deleted', async () => {
  const subject = (await request(app).post('/api/subjects').send({ name: 'Chemistry' })).body;
  const note = (await request(app).post('/api/notes').send({ subject_id: subject.id, title: 'Atoms', content: NOTE_TEXT })).body;
  const card = await request(app).post('/api/flashcards').send({ note_id: note.id, front: 'Q', back: 'A' });
  assert.equal(card.status, 201);

  const byNote = await request(app).get(`/api/flashcards?note_id=${note.id}`);
  assert.equal(byNote.body.length, 1);

  await request(app).delete(`/api/subjects/${subject.id}`);
  const after = await request(app).get(`/api/flashcards?note_id=${note.id}`);
  assert.equal(after.body.length, 0);
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
  assert.ok(res.body.flashcards.length > 0);
  assert.ok(res.body.quiz.length > 0);
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
