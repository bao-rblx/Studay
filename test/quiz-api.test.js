// Quiz API: a quiz is built from this account's notes and files with no AI key, and answers
// are graded on the server so the browser never has to copy the rules.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupWithUser, request } = require('./helpers');

const NOTE_TEXT = 'Photosynthesis converts light energy into chemical energy inside the chloroplast. '
  + 'Chlorophyll absorbs mostly blue and red light from the sunlight. '
  + 'The process releases oxygen as a by-product into the atmosphere. '
  + 'Plants store the extra glucose as starch in their roots and leaves. '
  + 'Cellular respiration then breaks the glucose down again for energy. '
  + 'Stomata are small pores that let carbon dioxide enter the leaf.';

const VI_TEXT = 'Quang hợp là quá trình thực vật sử dụng ánh sáng mặt trời để tổng hợp chất hữu cơ. '
  + 'Diệp lục trong lá hấp thụ chủ yếu ánh sáng đỏ và ánh sáng xanh tím. '
  + 'Quá trình này giải phóng khí ôxy ra khí quyển và tạo ra năng lượng cho cây.';

// A subject with one note, which is all a quiz needs.
async function subjectWithNote(agent, { name = 'Biology', text = NOTE_TEXT } = {}) {
  const subject = (await agent.post('/api/subjects').send({ name })).body;
  await agent.post('/api/notes').send({ subject_id: subject.id, title: 'Week 1', content: text });
  return subject;
}

const graded = (list) => list.filter((q) => q.type !== 'selfCheck');

test('a quiz is built from a subject notes with no AI key', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent);

  const res = await agent.post('/api/quiz').send({ subject_id: subject.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'local');
  assert.equal(res.body.title, 'Biology');
  assert.equal(res.body.subject_id, subject.id);
  assert.equal(res.body.count, res.body.questions.length);
  assert.ok(res.body.questions.length >= 3);
  assert.deepEqual(res.body.questions.map((q) => q.id), res.body.questions.map((_, i) => `q${i + 1}`));

  for (const question of res.body.questions) {
    assert.ok(['mcq', 'cloze', 'selfCheck'].includes(question.type));
    assert.ok(question.prompt.length > 0);
    assert.ok(question.answer.length > 0);
    if (question.type === 'mcq') {
      assert.equal(question.options.length, 4);
      assert.equal(new Set(question.options).size, 4);
      assert.equal(question.options[question.answer_index], question.answer);
    }
    if (question.type !== 'selfCheck') assert.ok(!question.prompt.includes(question.answer));
  }
});

test('the same seed gives the same quiz, a new seed gives new questions', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent);

  const first = await agent.post('/api/quiz').send({ subject_id: subject.id, seed: 5 });
  const again = await agent.post('/api/quiz').send({ subject_id: subject.id, seed: 5 });
  assert.deepEqual(again.body.questions, first.body.questions);

  const other = await agent.post('/api/quiz').send({ subject_id: subject.id, seed: 6 });
  assert.notDeepEqual(other.body.questions, first.body.questions);
});

test('count is honoured and clamped, seed echoes back', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent);

  const short = await agent.post('/api/quiz').send({ subject_id: subject.id, count: 3, seed: 2 });
  assert.equal(short.body.questions.length, 3);
  assert.equal(short.body.count, 3);
  assert.equal(short.body.seed, 2);

  const huge = await agent.post('/api/quiz').send({ subject_id: subject.id, count: 999 });
  assert.ok(huge.body.questions.length <= 12);
  assert.ok(huge.body.seed >= 1, 'a missing seed falls back to 1');
});

test('a quiz can be made from one file instead of a whole subject', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent, { text: 'A single short note that is not enough on its own to quiz.' });
  const material = (await agent.post('/api/materials').send({
    subject_id: subject.id, title: 'Reader chapter 2', content: NOTE_TEXT,
  })).body;

  const res = await agent.post('/api/quiz').send({ material_id: material.id });
  assert.equal(res.status, 200);
  assert.equal(res.body.material_id, material.id);
  assert.equal(res.body.title, 'Reader chapter 2');
  assert.ok(graded(res.body.questions).length >= 2);
});

test('material that is too thin says exactly what to add', async () => {
  const { agent } = await setupWithUser();
  const empty = (await agent.post('/api/subjects').send({ name: 'Empty' })).body;

  const res = await agent.post('/api/quiz').send({ subject_id: empty.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /add a note or a file/);
  assert.equal(res.body.min_chars, 60);
  assert.equal(res.body.chars, 0);

  const tiny = (await agent.post('/api/subjects').send({ name: 'Tiny' })).body;
  await agent.post('/api/notes').send({ subject_id: tiny.id, title: 'Stub', content: 'too short' });
  assert.equal((await agent.post('/api/quiz').send({ subject_id: tiny.id })).status, 400);
});

test('quiz requests are validated and scoped to the signed-in account', async () => {
  const { agent, app } = await setupWithUser({ email: 'first@example.com' });
  const subject = await subjectWithNote(agent);

  assert.equal((await agent.post('/api/quiz').send({})).status, 400);
  assert.equal((await agent.post('/api/quiz').send({ subject_id: 'abc' })).status, 400);
  assert.equal((await agent.post('/api/quiz').send({ subject_id: 424242 })).status, 404);
  assert.equal((await agent.post('/api/quiz').send({ material_id: 424242 })).status, 404);
  assert.equal((await request(app).post('/api/quiz').send({ subject_id: subject.id })).status, 401);

  // Another account cannot quiz itself on someone else's subject or file.
  const other = request.agent(app);
  await other.post('/api/auth/register').send({ email: 'second@example.com', password: 'password123' });
  assert.equal((await other.post('/api/quiz').send({ subject_id: subject.id })).status, 404);
});

test('the old /api/ai/quiz path still answers with a quiz array', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent);

  const res = await agent.post('/api/ai/quiz').send({ subject_id: subject.id });
  assert.equal(res.status, 200);
  assert.ok(res.body.quiz.length > 0);
  assert.deepEqual(res.body.quiz, res.body.questions);

  const empty = (await agent.post('/api/subjects').send({ name: 'Empty' })).body;
  assert.equal((await agent.post('/api/ai/quiz').send({ subject_id: empty.id })).status, 400);
});

test('answers are graded on the server, including typed Vietnamese answers', async () => {
  const { agent } = await setupWithUser();
  const subject = await subjectWithNote(agent, { name: 'Sinh học', text: VI_TEXT });
  const { questions } = (await agent.post('/api/quiz').send({ subject_id: subject.id, seed: 3 })).body;

  const mcq = questions.find((q) => q.type === 'mcq');
  assert.ok(mcq, 'the material should produce at least one multiple choice question');
  const right = await agent.post('/api/quiz/check').send({ question: mcq, answer: mcq.answer_index });
  assert.deepEqual(right.body, { correct: true, expected: mcq.answer });
  const wrong = await agent.post('/api/quiz/check').send({ question: mcq, answer: (mcq.answer_index + 1) % 4 });
  assert.deepEqual(wrong.body, { correct: false, expected: mcq.answer });

  const cloze = questions.find((q) => q.type === 'cloze');
  assert.ok(cloze, 'the material should produce at least one typed question');
  // Case, extra spaces and missing diacritics are all forgiven.
  const typed = await agent.post('/api/quiz/check').send({ question: cloze, answer: `  ${cloze.answer}  ` });
  assert.equal(typed.body.correct, true);
  const unaccented = cloze.answer.normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/gi, 'd');
  assert.equal((await agent.post('/api/quiz/check').send({ question: cloze, answer: unaccented })).body.correct, true);
  assert.equal((await agent.post('/api/quiz/check').send({ question: cloze, answer: '' })).body.correct, false);
  assert.equal((await agent.post('/api/quiz/check').send({ question: cloze, answer: 'nonsense' })).body.correct, false);

  const selfCheck = questions.find((q) => q.type === 'selfCheck');
  if (selfCheck) {
    const out = await agent.post('/api/quiz/check').send({ question: selfCheck, answer: 'anything' });
    assert.deepEqual(out.body, { selfCheck: true });
  }
});

test('checking a broken question is a 400, not a crash', async () => {
  const { agent } = await setupWithUser();
  assert.equal((await agent.post('/api/quiz/check').send({})).status, 400);
  assert.equal((await agent.post('/api/quiz/check').send({ question: 'nope' })).status, 400);
  assert.equal((await agent.post('/api/quiz/check').send({ question: { prompt: 'hi' } })).status, 400);
  const long = await agent.post('/api/quiz/check').send({
    question: { type: 'cloze', prompt: 'The green pigment is _____.', answer: 'chlorophyll' },
    answer: 'x'.repeat(1200),
  });
  assert.equal(long.status, 400);
});
