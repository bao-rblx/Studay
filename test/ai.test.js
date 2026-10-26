const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateStudyAids } = require('../ai');

const TEXT = 'Photosynthesis converts light energy into chemical energy. '
  + 'Chlorophyll absorbs mostly blue and red light in the leaves. '
  + 'The process releases oxygen as a by-product into the atmosphere.';
const quiet = { warn: () => {} };

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const geminiBody = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

test('no API key: offline generator is used', async () => {
  const out = await generateStudyAids(TEXT, 'all', { apiKey: '' });
  assert.equal(out.source, 'offline');
  assert.ok(out.summary && out.flashcards && out.quiz);
});

test('Gemini success: AI output is returned', async () => {
  const fetchImpl = reply(200, geminiBody({
    summary: { summary: 'Plants make food from light.', key_points: ['light', 'oxygen'] },
    flashcards: [{ front: 'What absorbs light?', back: 'Chlorophyll' }],
    quiz: [{ question: 'Gas released?', options: ['Oxygen', 'Nitrogen', 'Helium'], answer_index: 0, explanation: 'From the note' }],
  }));
  const out = await generateStudyAids(TEXT, 'all', { apiKey: 'test', fetchImpl, log: quiet });
  assert.equal(out.source, 'gemini');
  assert.equal(out.flashcards[0].back, 'Chlorophyll');
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
