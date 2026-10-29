const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateStudyAids, scanTimetable, parseQuickNote, parseQuickNoteOffline, readMaterial, askCompanion,
} = require('../ai');

const TEXT = 'Photosynthesis converts light energy into chemical energy. '
  + 'Chlorophyll absorbs mostly blue and red light in the leaves. '
  + 'The process releases oxygen as a by-product into the atmosphere.';
const quiet = { warn: () => {} };

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => '' });
const geminiBody = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const gemini = (obj) => ({ apiKey: 'test', fetchImpl: reply(200, geminiBody(obj)), log: quiet });

// --- summary + quiz ---
test('no API key: offline generator is used', async () => {
  const out = await generateStudyAids(TEXT, 'all', { apiKey: '' });
  assert.equal(out.source, 'offline');
  assert.ok(out.summary && out.quiz);
  assert.equal(out.flashcards, undefined);
});

test('Gemini success: AI output is returned', async () => {
  const out = await generateStudyAids(TEXT, 'all', gemini({
    summary: { summary: 'Plants make food from light.', key_points: ['light', 'oxygen'] },
    quiz: [{ question: 'Gas released?', options: ['Oxygen', 'Nitrogen', 'Helium'], answer_index: 0, explanation: 'From the note' }],
  }));
  assert.equal(out.source, 'gemini');
  assert.equal(out.quiz[0].options[0], 'Oxygen');
});

test('429 from Gemini: falls back with a rate_limited notice', async () => {
  const out = await generateStudyAids(TEXT, 'all', { apiKey: 'test', fetchImpl: reply(429, {}), log: quiet });
  assert.equal(out.source, 'offline');
  assert.equal(out.fallback_reason, 'rate_limited');
  assert.match(out.notice, /busy/);
  assert.ok(out.summary);
});

test('timeout: falls back with a timeout notice', async () => {
  const fetchImpl = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const out = await generateStudyAids(TEXT, 'all', { apiKey: 'test', fetchImpl, log: quiet });
  assert.equal(out.fallback_reason, 'timeout');
});

test('empty or malformed answer: falls back', async () => {
  const empty = await generateStudyAids(TEXT, 'all', { apiKey: 'test', fetchImpl: reply(200, { candidates: [] }), log: quiet });
  assert.equal(empty.fallback_reason, 'empty');
  const bad = await generateStudyAids(TEXT, 'all', {
    apiKey: 'test', fetchImpl: reply(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), log: quiet,
  });
  assert.equal(bad.fallback_reason, 'bad_output');
});

test('500 from Gemini: falls back with an upstream notice', async () => {
  const out = await generateStudyAids(TEXT, 'quiz', { apiKey: 'test', fetchImpl: reply(500, {}), log: quiet });
  assert.equal(out.fallback_reason, 'upstream');
  assert.ok(out.quiz.length > 0);
});

// --- timetable scan ---
test('timetable scan: keeps valid subjects and drops bad schedule rows', async () => {
  const out = await scanTimetable({ mimeType: 'image/png', data: 'AAAA' }, gemini({
    subjects: [
      { name: 'Databases', teacher: 'Dr. Lan', schedule: [{ day: 1, start: '07:30', end: '09:30' }, { day: 9, start: 'x' }] },
      { name: '', teacher: 'nobody' },
    ],
  }));
  assert.equal(out.source, 'gemini');
  assert.equal(out.subjects.length, 1);
  assert.deepEqual(out.subjects[0].schedule, [{ day: 1, start: '07:30', end: '09:30', room: null }]);
});

test('timetable scan without a key returns no subjects and a notice', async () => {
  const out = await scanTimetable({ mimeType: 'image/png', data: 'AAAA' }, { apiKey: '' });
  assert.equal(out.source, 'offline');
  assert.deepEqual(out.subjects, []);
  assert.ok(out.notice);
});

// --- quick note -> event ---
test('quick note offline: "next week" and keywords become a presentation event', () => {
  // 2025-11-05 is a Wednesday; next week without a weekday = Monday 2025-11-10.
  const { event } = parseQuickNoteOffline('present databases next week', '2025-11-05', [{ id: 3, name: 'Databases' }]);
  assert.equal(event.kind, 'presentation');
  assert.equal(event.event_date, '2025-11-10');
  assert.equal(event.subject_id, 3);
});

test('quick note offline: tomorrow, dd/mm and no date', () => {
  assert.equal(parseQuickNoteOffline('submit homework tomorrow', '2025-11-05').event.event_date, '2025-11-06');
  assert.equal(parseQuickNoteOffline('midterm 20/11', '2025-11-05').event.event_date, '2025-11-20');
  assert.equal(parseQuickNoteOffline('remember to buy pens', '2025-11-05').event, null);
});

test('quick note Gemini: unknown subject id and bad kind are cleaned', async () => {
  const out = await parseQuickNote('exam friday', { today: '2025-11-05', subjects: [{ id: 1, name: 'Math' }] }, gemini({
    event: { title: 'Exam', kind: 'party', event_date: '2025-11-07', start_time: '25:00', subject_id: 99 },
  }));
  assert.equal(out.source, 'gemini');
  assert.deepEqual(out.event, { title: 'Exam', kind: 'other', event_date: '2025-11-07', start_time: null, subject_id: null, details: null });
});

// --- teacher material ---
test('read material: Gemini returns text and summary', async () => {
  const out = await readMaterial({ mimeType: 'application/pdf', data: 'AAAA', filename: 'week3.pdf' }, gemini({
    title: 'Week 3', content: TEXT, summary: { summary: 'About photosynthesis.', key_points: ['light'] },
  }));
  assert.equal(out.title, 'Week 3');
  assert.equal(out.summary.summary, 'About photosynthesis.');
});

test('read material offline: plain text is summarised, a PDF without AI is not', async () => {
  const txt = await readMaterial({ text: TEXT, filename: 'notes.txt' }, { apiKey: '' });
  assert.equal(txt.title, 'notes');
  assert.ok(txt.summary.summary.length > 0);
  const pdf = await readMaterial({ mimeType: 'application/pdf', data: 'AAAA', filename: 'a.pdf' }, { apiKey: '' });
  assert.equal(pdf.summary, null);
});

// --- companion ---
test('companion: Gemini answer, and offline answer quotes the notes', async () => {
  const on = await askCompanion('what absorbs light?', TEXT, gemini({ answer: 'Chlorophyll!' }));
  assert.equal(on.answer, 'Chlorophyll!');
  const off = await askCompanion('what does chlorophyll absorb?', TEXT, { apiKey: '' });
  assert.match(off.answer, /Chlorophyll/);
});
