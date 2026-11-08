// One student, one afternoon: the whole product used the way the UI uses it.
// The other suites test each feature on its own; this one proves the waves fit together
// (accounts -> subject -> note -> Word file -> quiz -> search -> calendar -> delete).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, setupWithUser, request } = require('./helpers');
const { docx, para } = require('./office-fixture');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const LESSON = 'Chuẩn hoá dữ liệu loại bỏ dư thừa trong cơ sở dữ liệu quan hệ. '
  + 'Khoá chính xác định duy nhất mỗi bản ghi trong bảng. '
  + 'Chỉ mục giúp tăng tốc độ truy vấn trên cột được đánh chỉ mục.';

test('a study session works end to end', async () => {
  const { agent } = await setupWithUser({ email: 'session@example.com', name: 'Mai' });

  // 1. The subject dialog creates a subject.
  const subject = (await agent.post('/api/subjects')
    .send({ name: 'Hệ cơ sở dữ liệu', teacher: 'Cô Lan', room: 'B203', color: '#007aff' })).body;
  assert.ok(subject.id);

  // 2. A note, typed in the Notes view.
  const note = await agent.post('/api/notes')
    .send({ subject_id: subject.id, title: 'Chương 1 - Chuẩn hoá', content: LESSON });
  assert.equal(note.status, 201);

  // 3. A Word document from the teacher, dropped on the buddy panel: no AI key needed,
  //    the text is extracted locally and then summarised by the offline helper.
  const file = docx([para(LESSON), para('Giao dịch đảm bảo tính nguyên tử của nhóm thao tác.')].join('')).toString('base64');
  const read = await agent.post('/api/ai/read-material')
    .send({ file: { name: 'Chuong1.docx', mime_type: DOCX_MIME, data: file } });
  assert.equal(read.status, 200);
  assert.equal(read.body.extractor, 'local');
  assert.match(read.body.content, /Chuẩn hoá dữ liệu/);
  assert.ok(read.body.chars > 100);

  const material = await agent.post('/api/materials')
    .send({ subject_id: subject.id, title: read.body.title, filename: 'Chuong1.docx', content: read.body.content, summary: read.body.summary });
  assert.equal(material.status, 201);

  // 4. The quiz works from that material with no key: real questions, server-side grading.
  const quiz = await agent.post('/api/quiz').send({ subject_id: subject.id, count: 5 });
  assert.equal(quiz.status, 200);
  assert.equal(quiz.body.source, 'local');
  assert.ok(quiz.body.questions.length > 0);
  const first = quiz.body.questions.find((q) => q.type !== 'selfCheck') || quiz.body.questions[0];
  assert.ok(first.prompt.length > 0, 'a question must ask something');
  if (first.type !== 'selfCheck') {
    const right = await agent.post('/api/quiz/check').send({ question: first, answer: first.answer });
    assert.equal(right.body.correct, true);
    const wrong = await agent.post('/api/quiz/check').send({ question: first, answer: 'chắc chắn sai' });
    assert.equal(wrong.body.correct, false);
  }

  // 5. A deadline on the calendar.
  const event = await agent.post('/api/events')
    .send({ title: 'Thi giữa kỳ cơ sở dữ liệu', event_date: '2026-11-15', kind: 'exam', subject_id: subject.id });
  assert.equal(event.status, 201);

  // 6. Global search finds every kind of record by name (each one searched the way a
  //    student would type it, and every hit carries the subject it belongs to).
  const types = async (q) => (await agent.get(`/api/search?q=${encodeURIComponent(q)}`)).body.results;
  const subjectHits = await types('cơ sở');
  assert.ok(subjectHits.some((hit) => hit.type === 'subject' && hit.id === subject.id), 'the subject');
  const noteHits = await types('chương');
  assert.ok(noteHits.some((hit) => hit.type === 'note' && hit.title === 'Chương 1 - Chuẩn hoá'), 'the note');
  const fileHits = await types('chuong1');
  assert.ok(fileHits.some((hit) => hit.type === 'material' && hit.subject_name === 'Hệ cơ sở dữ liệu'), 'the teacher file by filename');
  const eventHits = await types('giữa kỳ');
  assert.ok(eventHits.some((hit) => hit.type === 'event' && hit.event_date === '2026-11-15'), 'the deadline, with a plain date');

  // 7. Deleting the subject takes its notes, files and events with it.
  assert.equal((await agent.delete(`/api/subjects/${subject.id}`)).status, 200);
  assert.equal((await agent.get('/api/notes')).body.length, 0);
  assert.equal((await agent.get('/api/materials')).body.length, 0);
  assert.equal((await agent.get('/api/events')).body.length, 0);
  assert.equal((await types('cơ sở')).length, 0);
});

test('a second account on the same server sees nothing of the first', async () => {
  const { app } = await setup();
  const first = request.agent(app);
  await first.post('/api/auth/register').send({ email: 'first@example.com', password: 'password123' });
  await first.post('/api/subjects').send({ name: 'Giải tích' });
  assert.equal((await first.get('/api/subjects')).body.length, 1);

  const second = request.agent(app);
  await second.post('/api/auth/register').send({ email: 'second@example.com', password: 'password123' });
  assert.equal((await second.get('/api/subjects')).body.length, 0);
  assert.equal((await second.get('/api/search?q=giải')).body.results.length, 0);
});
