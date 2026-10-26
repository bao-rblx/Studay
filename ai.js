// Studay AI-assisted feature.
// Primary: Google Gemini (src/gemini.js), called from the server only.
// Fallback: offline extractive generator below, used when the key is missing or the API fails.
// Modes: 'summary' | 'flashcards' | 'quiz' | 'all'. Unknown modes fall back to 'all'.
const { callGemini, AiError } = require('./src/gemini');

const STOPWORDS = new Set(
  'a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,of,to,in,on,is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,may,might,must,as,it,its,this,that,these,those,from,not,no,so,such,than,too,very,just,also,there,their,they,them,his,her,our,you,your,we,us,i,he,she,we,our,my,me,his,ours'.split(',')
);

function splitSentences(text) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function keywords(text, limit = 8) {
  const freq = new Map();
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/)) {
    if (w.length > 3 && !STOPWORDS.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

function scoreSentences(sentences, keys) {
  const keySet = new Set(keys);
  return sentences
    .map((s, i) => {
      const words = s.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/);
      let score = words.reduce((n, w) => n + (keySet.has(w) ? 1 : 0), 0) / Math.max(1, Math.sqrt(words.length));
      if (i === 0) score += 0.5;
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);
}

function summarize(text) {
  const sentences = splitSentences(text);
  const keys = keywords(text);
  const ranked = scoreSentences(sentences, keys);
  const top = ranked.slice(0, 3).map((r) => r.s).sort((a, b) => sentences.indexOf(a) - sentences.indexOf(b));
  return {
    summary: top.join(' ') || 'Not enough text to summarise — paste at least a paragraph.',
    key_points: ranked.slice(0, 5).map((r) => (r.s.length > 140 ? r.s.slice(0, 137) + '...' : r.s)),
  };
}

// Cloze-style flashcards: blank out the most salient keyword in the sentence.
function makeFlashcards(text) {
  const sentences = splitSentences(text);
  const keys = new Set(keywords(text, 12));
  return sentences.slice(0, 6).map((s, i) => {
    const words = s.split(' ');
    const blankIdx = words.findIndex((w) => keys.has(w.toLowerCase().replace(/[^a-z0-9-]/g, '')));
    const front = blankIdx >= 0
      ? `Card ${i + 1}: ${[...words.slice(0, blankIdx), '＿＿＿', ...words.slice(blankIdx + 1)].join(' ')}`
      : `Card ${i + 1}: What is the key idea here? — "${words.slice(0, Math.max(3, Math.floor(words.length / 2))).join(' ')}..."`;
    return { front, back: s };
  });
}

// Quiz: correct answer = source sentence, distractors drawn from OTHER
// sentences in the same note (plausible), falling back to generic ones.
function makeQuiz(text) {
  const sentences = splitSentences(text);
  return sentences.slice(0, 5).map((s, i) => {
    const others = sentences.filter((x) => x !== s).slice(0, 2);
    while (others.length < 2) others.push('This topic was not covered in the notes.');
    return {
      question: `Q${i + 1}: Which statement best matches your notes?`,
      options: [s, ...others],
      answer_index: 0,
      explanation: `Answer A is taken directly from your note: "${s.length > 100 ? s.slice(0, 97) + '...' : s}"`,
    };
  });
}

function generateOffline(text, mode = 'all') {
  const out = {};
  const m = ['summary', 'flashcards', 'quiz'].includes(mode) ? mode : 'all';
  if ((m === 'all' || m === 'summary') && text.trim().length >= 30) out.summary = summarize(text);
  if ((m === 'all' || m === 'flashcards') && text.trim().length >= 30) out.flashcards = makeFlashcards(text);
  if (m === 'all' || m === 'quiz') out.quiz = makeQuiz(text);
  return out;
}

const NOTICES = {
  rate_limited: 'The AI is busy (free quota reached). Showing a basic offline version instead - try again in a minute.',
  timeout: 'The AI took too long to answer. Showing a basic offline version instead.',
  upstream: 'The AI service is unavailable right now. Showing a basic offline version instead.',
  empty: 'The AI returned nothing usable. Showing a basic offline version instead.',
  bad_output: 'The AI returned something we could not read. Showing a basic offline version instead.',
};

// Keep only well-formed items so a malformed AI answer cannot break the page.
function sanitize(ai, mode) {
  const out = {};
  const m = ['summary', 'flashcards', 'quiz'].includes(mode) ? mode : 'all';
  if ((m === 'all' || m === 'summary') && ai.summary && typeof ai.summary.summary === 'string') {
    out.summary = {
      summary: ai.summary.summary,
      key_points: Array.isArray(ai.summary.key_points) ? ai.summary.key_points.map(String).slice(0, 8) : [],
    };
  }
  if ((m === 'all' || m === 'flashcards') && Array.isArray(ai.flashcards)) {
    out.flashcards = ai.flashcards
      .filter((c) => c && c.front && c.back)
      .slice(0, 10)
      .map((c) => ({ front: String(c.front), back: String(c.back) }));
  }
  if ((m === 'all' || m === 'quiz') && Array.isArray(ai.quiz)) {
    out.quiz = ai.quiz
      .filter((q) => q && q.question && Array.isArray(q.options) && q.options.length >= 2
        && Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index < q.options.length)
      .slice(0, 10)
      .map((q) => ({ question: String(q.question), options: q.options.map(String), answer_index: q.answer_index, explanation: String(q.explanation || '') }));
  }
  return out;
}

// Gemini first; on any failure fall back to the offline generator and tell the user why.
async function generateStudyAids(text, mode = 'all', { apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL, fetchImpl, log = console } = {}) {
  if (!apiKey) return { source: 'offline', notice: 'AI key not configured - using the offline generator.', ...generateOffline(text, mode) };
  try {
    const out = sanitize(await callGemini(text, mode, { apiKey, model: model || undefined, fetchImpl }), mode);
    if (!Object.keys(out).length) throw new AiError('bad_output', 'AI output had none of the requested sections');
    return { source: 'gemini', ...out };
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : 'upstream';
    log.warn(`[ai] falling back to offline generator: ${kind} (${err.message})`);
    return { source: 'offline', fallback_reason: kind, notice: NOTICES[kind], ...generateOffline(text, mode) };
  }
}

module.exports = { generateStudyAids, generateOffline };
