const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuiz, grade, normalizeQuiz, MIN_TEXT } = require('../src/quiz');

const TEXT = 'Photosynthesis converts light energy into chemical energy inside the chloroplast. '
  + 'Chlorophyll absorbs mostly blue and red light from the sunlight. '
  + 'The process releases oxygen as a by-product into the atmosphere. '
  + 'Plants store the extra glucose as starch in their roots and leaves. '
  + 'Cellular respiration then breaks the glucose down again for energy. '
  + 'Stomata are small pores that let carbon dioxide enter the leaf.';

const VI_TEXT = 'Quang hợp là quá trình thực vật sử dụng ánh sáng mặt trời để tổng hợp chất hữu cơ. '
  + 'Diệp lục trong lá hấp thụ chủ yếu ánh sáng đỏ và ánh sáng xanh tím. '
  + 'Quá trình này giải phóng khí ôxy ra khí quyển và tạo ra năng lượng cho cây.';

const graded = (list) => list.filter((q) => q.type !== 'selfCheck');

// --- building --------------------------------------------------------------

test('same text and seed give the same quiz', () => {
  const a = buildQuiz(TEXT, { count: 6, seed: 42 });
  const b = buildQuiz(TEXT, { count: 8, seed: 42 }); // count only changes the length
  assert.deepEqual(buildQuiz(TEXT, { count: 6, seed: 42 }), a);
  assert.equal(a.source, 'local');
  assert.equal(b.questions.length, 8);
  assert.notDeepEqual(buildQuiz(TEXT, { count: 6, seed: 7 }), a);
});

test('multiple choice: four distinct options and exactly one correct', () => {
  const mcqs = buildQuiz(TEXT, { count: 6, seed: 1 }).questions.filter((q) => q.type === 'mcq');
  assert.ok(mcqs.length >= 2);
  for (const question of mcqs) {
    assert.equal(question.options.length, 4);
    assert.equal(new Set(question.options.map((o) => o.toLowerCase())).size, 4);
    assert.ok(Number.isInteger(question.answer_index) && question.answer_index >= 0 && question.answer_index < 4);
    assert.equal(question.options[question.answer_index], question.answer);
    assert.equal(question.options.filter((o) => o === question.answer).length, 1);
  }
});

test('questions are distinct, use only real answers and never leak them in the stem', () => {
  for (const seed of [1, 2, 3]) {
    const { questions } = buildQuiz(TEXT, { count: 8, seed });
    assert.equal(new Set(questions.map((q) => q.prompt)).size, questions.length);
    const source = TEXT.toLowerCase();
    for (const question of graded(questions)) {
      assert.ok(source.includes(question.answer.toLowerCase()), `invented answer: ${question.answer}`);
      assert.ok(question.prompt.includes('_____'), question.prompt);
      assert.ok(!question.prompt.toLowerCase().includes(question.answer.toLowerCase()), question.prompt);
      // The explanation is the untouched sentence the question was cut from.
      assert.ok(TEXT.includes(question.explanation), question.explanation);
    }
  }
});

test('Vietnamese material yields questions that keep the diacritics', () => {
  const { questions } = buildQuiz(VI_TEXT, { count: 5, seed: 1 });
  assert.ok(graded(questions).length >= 2);
  assert.ok(questions.some((q) => /[ăâđêôơư]/iu.test(q.answer.normalize('NFC'))));
  assert.ok(questions.some((q) => q.answer.includes(' ')), 'a two-syllable Vietnamese word is blanked as one');
  for (const question of graded(questions)) {
    assert.ok(VI_TEXT.toLowerCase().includes(question.answer.toLowerCase()), `invented answer: ${question.answer}`);
    assert.ok(!question.prompt.toLowerCase().includes(question.answer.toLowerCase()), question.prompt);
  }
});

test('thin material is padded with self-check cards, never faked', () => {
  const oneFact = 'Quang hợp là quá trình thực vật sử dụng ánh sáng mặt trời để tổng hợp chất hữu cơ.';
  const { questions } = buildQuiz(oneFact, { count: 6, seed: 2 });
  assert.equal(questions.length, 6);
  assert.ok(graded(questions).length >= 1 && graded(questions).length < 6);
  for (const question of questions.filter((q) => q.type === 'selfCheck')) {
    assert.match(question.prompt, /^Explain: \S/);
    assert.ok(question.answer.length > 0);
  }
});

test('short, garbage or thin input never throws', () => {
  assert.equal(MIN_TEXT, 60);
  const empty = { questions: [], source: 'local' };
  assert.deepEqual(buildQuiz('Too short to quiz me.'), empty);
  assert.deepEqual(buildQuiz(''), empty);
  assert.deepEqual(buildQuiz(null), empty);
  assert.deepEqual(buildQuiz(42), empty);
  assert.deepEqual(buildQuiz('x'.repeat(300)), empty);
  assert.deepEqual(buildQuiz('!!! ??? --- ... '.repeat(8)), empty);
  // count is clamped, and the text decides the real ceiling.
  assert.equal(buildQuiz(TEXT, { count: 0, seed: 1 }).questions.length, 1);
  assert.equal(buildQuiz(TEXT, { count: -5, seed: 1 }).questions.length, 1);
  assert.ok(buildQuiz(TEXT, { count: 500, seed: 1 }).questions.length <= 20);
});

// --- grading ---------------------------------------------------------------

test('grade multiple choice by index or by option text', () => {
  const question = { type: 'mcq', prompt: 'Gas released?', options: ['Alpha', 'Beta', 'Gamma'], answer_index: 1, answer: 'Beta' };
  assert.deepEqual(grade(question, 1), { correct: true, expected: 'Beta' });
  assert.deepEqual(grade(question, '1'), { correct: true, expected: 'Beta' });
  assert.equal(grade(question, 'Beta').correct, true);
  assert.equal(grade(question, ' beta ').correct, true);
  assert.equal(grade(question, 0).correct, false);
  assert.equal(grade(question, 'Alpha').correct, false);
  assert.equal(grade(question, '').correct, false);
});

test('grade typed answers ignores case, spacing and diacritics', () => {
  const question = { type: 'cloze', prompt: 'Quá trình quang hợp cần _____.', answer: 'ánh sáng' };
  assert.deepEqual(grade(question, ' Ánh   Sáng '), { correct: true, expected: 'ánh sáng' });
  assert.equal(grade(question, 'anh sang').correct, true);
  assert.equal(grade(question, 'ÁNH SÁNG.').correct, true);
  assert.equal(grade(question, 'ánh').correct, false);
  assert.deepEqual(grade(question, ''), { correct: false, expected: 'ánh sáng' });
  assert.equal(grade(question, '   ').correct, false);
});

test('grade never judges a self-check card, and survives junk input', () => {
  assert.deepEqual(grade({ type: 'selfCheck', prompt: 'Explain: light', answer: 'It is energy.' }, 'anything'), { selfCheck: true });
  assert.deepEqual(grade(null, 'x'), { correct: false, expected: '' });
  assert.deepEqual(grade({}, 'x'), { correct: false, expected: '' });
});

test('a built quiz grades itself correctly', () => {
  const { questions } = buildQuiz(TEXT, { count: 6, seed: 5 });
  for (const question of questions.filter((q) => q.type === 'mcq')) {
    assert.equal(grade(question, question.answer_index).correct, true);
    const wrong = (question.answer_index + 1) % question.options.length;
    assert.equal(grade(question, wrong).correct, false);
  }
  for (const question of questions.filter((q) => q.type === 'cloze')) {
    assert.equal(grade(question, question.answer.toUpperCase()).correct, true);
  }
});

// --- untrusted AI questions ------------------------------------------------

test('normalizeQuiz keeps readable AI questions in the shared shape', () => {
  const out = normalizeQuiz({
    questions: [
      { question: 'Which gas do plants release?', options: ['Oxygen', 'Nitrogen', 'Helium'], answer_index: 0, explanation: 'From the notes' },
      { type: 'cloze', prompt: 'The green pigment is _____.', answer: 'chlorophyll' },
      { type: 'selfCheck', prompt: 'Explain: chlorophyll', answer: 'The green pigment in leaves.' },
      { question: 'Answer sent as text instead of an index', options: ['Starch', 'Oxygen'], answer: 'Oxygen' },
    ],
  });
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], {
    id: 'q1', type: 'mcq', prompt: 'Which gas do plants release?', options: ['Oxygen', 'Nitrogen', 'Helium'],
    answer_index: 0, answer: 'Oxygen', explanation: 'From the notes',
  });
  assert.equal(out[1].type, 'cloze');
  assert.equal(out[1].answer, 'chlorophyll');
  assert.equal(out[2].type, 'selfCheck');
  assert.equal(out[3].answer_index, 1);
  assert.equal(grade(out[0], 'Oxygen').correct, true);
});

test('normalizeQuiz drops every broken entry', () => {
  const out = normalizeQuiz({
    questions: [
      null,
      'not an object',
      { question: 'no options and no answer' },
      { question: 'the correct option is a duplicate', options: ['Same', 'same', 'Other'], answer_index: 1 },
      { question: 'index is out of range here', options: ['One', 'Two'], answer_index: 7 },
      { question: 'tiny', options: ['A', 'B'], answer_index: 0 },
      { question: 'a single option is no question', options: ['Only'], answer_index: 0 },
      { question: 'which part of the plant is green?', options: ['Leaf', 'Root'], answer_index: 1 },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].answer, 'Root');
  assert.deepEqual(normalizeQuiz('nonsense'), []);
  assert.deepEqual(normalizeQuiz(undefined), []);
});

test('normalized AI questions and local ones share one shape', () => {
  const local = buildQuiz(TEXT, { count: 6, seed: 1 }).questions.find((q) => q.type === 'mcq');
  const [ai] = normalizeQuiz({ questions: [{ question: 'Which gas do plants release?', options: ['Oxygen', 'Nitrogen'], answer_index: 0 }] });
  const keys = (q) => Object.keys(q).sort().join(',');
  assert.equal(keys(local), keys(ai));
});

test('normalizeQuiz caps the length, renumbers ids and takes a bare list', () => {
  const item = (i) => ({ question: `Question number ${i} about the topic?`, options: ['One', 'Two', 'Three'], answer_index: 2 });
  const list = [1, 2, 3, 4, 5].map(item);
  const capped = normalizeQuiz(list, { max: 3 });
  assert.equal(capped.length, 3);
  assert.deepEqual(capped.map((q) => q.id), ['q1', 'q2', 'q3']);
  assert.equal(normalizeQuiz({ quiz: list }).length, 5);
  assert.equal(normalizeQuiz({ questions: list }, { max: 0 }).length, 1);
});
