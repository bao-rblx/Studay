// Quiz endpoints: build a quiz from this account's study material, and grade one answer.
// The local engine in src/quiz.js does the work, so the page never needs a Gemini key.
// Gemini is only asked for extra questions when the notes are too thin for a full quiz.
const express = require('express');
const { wrap, isId, AI_MAX_CHARS, QUESTION_MAX_CHARS } = require('../lib/helpers');
const { buildQuiz, grade, normalizeQuiz, MIN_TEXT } = require('../quiz');

const DEFAULT_COUNT = 8;
const MAX_COUNT = 12;

const quizCount = (value) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_COUNT, n) : DEFAULT_COUNT;
};
const quizSeed = (value) => (Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 1);

module.exports = ({ q, one, AI }) => {
  const router = express.Router();

  // The material a quiz can be built from: one file, or everything saved for one subject.
  // Every query is scoped to req.userId, so one account never sees another's notes.
  async function readSource(userId, body) {
    const { material_id, subject_id } = body || {};
    if (material_id) {
      if (!isId(material_id)) return { status: 400, error: 'invalid material_id' };
      const material = await one(
        'SELECT title, subject_id, content FROM materials WHERE id = $1 AND user_id = $2',
        [material_id, userId],
      );
      if (!material) return { status: 404, error: 'material not found' };
      return {
        text: `${material.title}\n${material.content}`.trim(),
        title: material.title,
        subject_id: material.subject_id,
        material_id: Number(material_id),
      };
    }
    if (!subject_id) return { status: 400, error: 'subject_id or material_id required' };
    if (!isId(subject_id)) return { status: 400, error: 'invalid subject_id' };
    const subject = await one('SELECT id, name FROM subjects WHERE id = $1 AND user_id = $2', [subject_id, userId]);
    if (!subject) return { status: 404, error: 'subject not found' };
    const rows = [
      ...await q(
        'SELECT title, content FROM materials WHERE user_id = $1 AND subject_id = $2 ORDER BY id DESC LIMIT 8',
        [userId, subject_id],
      ),
      ...await q(
        'SELECT title, content FROM notes WHERE user_id = $1 AND subject_id = $2 ORDER BY id DESC LIMIT 12',
        [userId, subject_id],
      ),
    ];
    return {
      text: rows.map((r) => `${r.title}\n${r.content}`).join('\n\n').trim(),
      title: subject.name,
      subject_id: subject.id,
      material_id: null,
    };
  }

  // Local questions first - they need no key and no network. Only a quiz that comes out short
  // asks Gemini for more, and a failing API never gets in the way of the page.
  async function assemble(text, want, seed) {
    const body = text.slice(0, AI_MAX_CHARS);
    const questions = buildQuiz(body, { count: want, seed }).questions.slice();
    let source = 'local';
    if (questions.length < want && process.env.GEMINI_API_KEY) {
      const out = await AI.generateStudyAids(body, 'quiz').catch(() => null);
      if (out && out.source === 'gemini') {
        const seen = new Set(questions.map((q) => q.prompt.toLowerCase()));
        for (const extra of normalizeQuiz(out.quiz, { max: want })) {
          if (questions.length >= want) break;
          if (seen.has(extra.prompt.toLowerCase())) continue;
          seen.add(extra.prompt.toLowerCase());
          questions.push(extra);
          source = 'gemini';
        }
      }
    }
    // Ids are renumbered after a merge so the page can key on them.
    return { source, questions: questions.slice(0, want).map((q, i) => ({ ...q, id: `q${i + 1}` })) };
  }

  async function build(req) {
    const body = req.body || {};
    const want = quizCount(body.count);
    const seed = quizSeed(body.seed);
    const found = await readSource(req.userId, body);
    if (found.error) return { status: found.status, body: { error: found.error } };
    if (found.text.length < MIN_TEXT) {
      return {
        status: 400,
        body: {
          error: `not enough material for a quiz yet - add a note or a file with at least ${MIN_TEXT} `
            + 'characters of text, then try again',
          chars: found.text.length,
          min_chars: MIN_TEXT,
        },
      };
    }
    const quiz = await assemble(found.text, want, seed);
    if (!quiz.questions.length) {
      return {
        status: 400,
        body: { error: 'could not write questions from this material - add a longer note or file' },
      };
    }
    return {
      status: 200,
      body: {
        ...quiz,
        title: found.title,
        subject_id: found.subject_id,
        material_id: found.material_id,
        count: quiz.questions.length,
        seed,
      },
    };
  }

  // The quiz page asks for a deterministic local quiz (same seed = same questions).
  router.post('/quiz', wrap(async (req, res) => {
    const { status, body } = await build(req);
    res.status(status).json(body);
  }));

  // Older path, kept working for the previous page and its tests: same quiz, also under `quiz`.
  router.post('/ai/quiz', wrap(async (req, res) => {
    const { status, body } = await build(req);
    res.status(status).json(status === 200 ? { ...body, quiz: body.questions } : body);
  }));

  // Grade one answer. Typed answers come back here so the diacritic and spacing rules stay
  // in one place instead of being copied into the browser.
  router.post('/quiz/check', wrap(async (req, res) => {
    const { question, answer } = req.body || {};
    if (!question || typeof question !== 'object') return res.status(400).json({ error: 'question required' });
    if (typeof answer === 'string' && answer.length > QUESTION_MAX_CHARS) {
      return res.status(400).json({ error: 'answer too long' });
    }
    const [known] = normalizeQuiz({ questions: [question] });
    if (!known) return res.status(400).json({ error: 'unknown question - ask for a new quiz' });
    res.json(grade(known, answer));
  }));

  return router;
};
