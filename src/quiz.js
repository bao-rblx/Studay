// Deterministic local quiz engine.
// Turns plain study text into a short quiz without an API key, so the quiz page keeps working
// when Gemini is missing or down. Everything here is pure: the same text and seed always give
// the same quiz (easy to test), and AI questions can reuse the shape through normalizeQuiz.

const MIN_TEXT = 60; // shorter material cannot produce a fair question; the route should ask for more
const MAX_COUNT = 20;
const MAX_QUESTIONS = 12;
const MAX_STEM = 220; // a 600-character stem is unreadable on a phone
const MAX_OPTIONS = 6;
const MIN_OPTIONS = 2;
const MIN_SENTENCE = 20; // a fragment this short has no context left after blanking a word
const MIN_PROMPT = 12;
const MAX_TERM = 32; // longer "words" are usually pasted junk, not key terms
const MIN_TERM = 4; // shorter single words make poor answer options
const BLANK = '_____';

// Words that never make a good answer. Kept deliberately short: an over-eager list starts
// deleting the topic words themselves. Vietnamese is written with spaces between syllables,
// so its syllables belong here too.
const EN_STOPWORDS = 'a,an,the,and,or,but,if,then,else,when,at,by,for,with,about,into,through,of,to,in,on,'
  + 'is,are,was,were,be,been,being,have,has,had,do,does,did,will,would,can,could,should,may,might,must,'
  + 'as,it,its,this,that,these,those,from,not,no,so,such,than,too,very,just,also,there,their,they,them,'
  + 'his,her,our,you,your,we,us,i,he,she,my,me,ours,which,what,who,whom,whose,how,all,any,each,few,'
  + 'more,most,other,some,only,own,same,one,two,three,first,second,new,like,well,even,still,however,'
  + 'therefore,thus,while,between,over,under,after,before,during,without,within,upon,yet,per,via,'
  + 'use,used,uses,using,make,makes,made,etc,eg,ie';
const VI_STOPWORDS = 'và,là,của,có,cho,các,những,một,trong,để,khi,thì,mà,với,này,đó,kia,từ,đến,trên,dưới,'
  + 'ra,vào,đi,rồi,như,nhưng,vì,nên,nếu,sẽ,đã,đang,bị,được,cũng,chỉ,còn,ở,tới,về,theo,hay,hoặc,do,'
  + 'bởi,tại,qua,sau,trước,giữa,ngoài,lên,xuống,tất,cả,rất,quá,hơn,ít,nhiều,mỗi,mọi,ai,gì,sao,nào,'
  + 'đâu,thế,vậy,chúng,ta,tôi,bạn,anh,chị,em,họ,nó,làm,người,cái,con,việc,điều,vẫn,đều,chính,ngay,'
  + 'hãy,đừng,chưa,không,phải,biết,thấy,muốn,cần,nữa,rằng,thành,nhờ,vừa,mới,nhất';
const STOPWORDS = new Set([...EN_STOPWORDS.split(','), ...VI_STOPWORDS.split(',')]);

const WORD = /[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu;
const MARKS = /\p{M}+/gu;
// Vietnamese identity marks survive NFD as combining characters (circumflex, breve, horn, đ),
// which catches "ợ"/"ặ" that a plain character class would miss.
const VIETNAMESE = /[\u0302\u0306\u031bđ]/u;
const looksVietnamese = (text) => VIETNAMESE.test(String(text).normalize('NFD'));

// --- small deterministic helpers -------------------------------------------

// mulberry32: tiny seeded PRNG, good enough for shuffling and stable across runs.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Whole-word matcher: "học" must not match inside "trường học" as part of a longer token.
function termRe(term, flags = 'giu') {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, flags);
}

// Grading is forgiving: case, extra spaces, punctuation and Vietnamese diacritics are all
// ignored, because typing them perfectly is not what the quiz is testing.
function normalizeAnswer(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFD')
    .replace(MARKS, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// --- text analysis ---------------------------------------------------------

const words = (text) => String(text).match(WORD) || [];

// Notes usually break one fact per line or sentence, so both count as a boundary.
function splitSentences(text) {
  return String(text)
    .split(/\n+|<br\s*\/?>|(?<=[.!?\u2026])\s+/iu)
    .map((s) => s.replace(/^[\s*•·\u2013\u2014-]+/u, '').replace(/\s+/gu, ' ').trim())
    .filter((s) => s.length >= MIN_SENTENCE && /\p{L}/u.test(s));
}

function isKeyToken(token) {
  return token.length >= 3 && token.length <= MAX_TERM && /\p{L}{2,}/u.test(token) && !STOPWORDS.has(token);
}

// One Vietnamese syllable: short, but it may be half of a real word.
const isSyllable = (token) => token.length >= 2 && token.length <= 6 && /\p{L}{2,}/u.test(token);

// Key terms of the whole text, best first: repeated words beat one-off words, and a whole
// phrase beats the pieces inside it ("ánh sáng" before "ánh").
function keyTerms(text, sentences) {
  const counts = new Map();
  const pairs = new Map();
  const leftOf = new Map();
  const rightOf = new Map();
  const bump = (term, n = 1) => counts.set(term, (counts.get(term) || 0) + n);
  const note = (map, token, neighbour) => {
    if (!map.has(token)) map.set(token, new Set());
    map.get(token).add(neighbour);
  };
  const vietnamese = looksVietnamese(text);

  for (const sentence of sentences) {
    const tokens = words(sentence).map((w) => w.toLowerCase());
    for (const token of tokens) if (isKeyToken(token)) bump(token);
    if (!vietnamese) continue;
    for (let i = 0; i < tokens.length; i += 1) {
      // '' marks a sentence edge, so a pair never spans two unrelated facts.
      note(leftOf, tokens[i], i === 0 ? '' : tokens[i - 1]);
      note(rightOf, tokens[i], i === tokens.length - 1 ? '' : tokens[i + 1]);
      const [a, b] = [tokens[i], tokens[i + 1]];
      if (b && isSyllable(a) && isSyllable(b) && (isKeyToken(a) || isKeyToken(b))) {
        pairs.set(`${a} ${b}`, (pairs.get(`${a} ${b}`) || 0) + 1);
      }
    }
  }
  // A syllable that always sits next to another word is only half of that word.
  const standalone = (token, map) => [...(map.get(token) || [])].every((n) => n === '' || !isKeyToken(n));
  if (vietnamese) {
    // Vietnamese words are two syllables written apart, so half a word ("sáng" out of "ánh sáng")
    // makes a poor question. Keep a pair when it repeats, or when both syllables are only ever
    // seen together and neither is glued to another word ("quang hợp" vs. "thụ chủ" cut out of
    // "hấp thụ chủ yếu").
    for (const [pair, n] of pairs) {
      const [a, b] = pair.split(' ');
      const glued = rightOf.get(a).size === 1 && rightOf.get(a).has(b)
        && leftOf.get(b).size === 1 && leftOf.get(b).has(a);
      if (n >= 2 || (glued && standalone(a, leftOf) && standalone(b, rightOf))) bump(pair, n);
    }
  }

  const scoreOf = (term) => (counts.get(term) || 0) * (term.includes(' ') ? 1.6 : 1);
  const ranked = [...counts.keys()]
    .sort((x, y) => scoreOf(y) - scoreOf(x) || y.length - x.length || (x < y ? -1 : 1));
  const kept = [];
  for (const term of ranked) {
    if (kept.some((other) => other.length > term.length && termRe(term, 'iu').test(other))) continue;
    kept.push(term);
  }
  // A bare three-letter syllable ("hợp", "mặt") is too little to ask about: as an option it
  // reads like a typo, as an answer it is guesswork.
  const usable = kept.filter((term) => term.includes(' ') || term.length >= MIN_TERM);
  // Vietnamese options should be whole words, not syllables cut out of one ("Phóng" out of
  // "giải phóng"). Dense single-sentence notes have no such words, so fall back instead of
  // returning nothing.
  const clean = vietnamese
    ? usable.filter((term) => term.includes(' ') || (standalone(term, leftOf) && standalone(term, rightOf)))
    : usable;
  return (clean.length >= 4 ? clean : usable).slice(0, 80);
}

// First surface form of the term in the text, so answers keep the original casing.
function surfaceOf(text, term) {
  const match = termRe(term, 'iu').exec(String(text));
  return match ? match[0] : '';
}

// Replace every occurrence of the term with the blank, so a repeated word cannot leak the answer.
function masked(sentence, term) {
  if (!termRe(term, 'iu').test(sentence)) return '';
  const stem = sentence.replace(termRe(term), BLANK);
  // "light" is still handed out for free when the stem keeps the word "sunlight".
  if (stem.toLowerCase().includes(term.toLowerCase())) return '';
  return stem.length >= MIN_PROMPT ? stem : '';
}

// Keep a long stem readable by centring it on the blank.
function focused(stem) {
  if (stem.length <= MAX_STEM) return stem;
  const at = stem.indexOf(BLANK);
  if (at < 0) return stem.slice(0, MAX_STEM);
  const start = Math.max(0, Math.min(at - Math.floor(MAX_STEM / 2), stem.length - MAX_STEM));
  const part = stem.slice(start, start + MAX_STEM).trim();
  return `${start > 0 ? '... ' : ''}${part}${start + MAX_STEM < stem.length ? ' ...' : ''}`;
}

// Three wrong answers taken from other key terms of the same text.
function pickDistractors(terms, answer, stem, text, rng, howMany = 3) {
  const used = new Set([normalizeAnswer(answer)]);
  const hidden = [];
  const visible = [];
  for (const term of shuffle(terms, rng)) {
    const key = normalizeAnswer(term);
    if (!key || used.has(key)) continue;
    const surface = surfaceOf(text, term);
    if (!surface || used.has(normalizeAnswer(surface))) continue;
    used.add(key);
    used.add(normalizeAnswer(surface));
    // A wrong option already visible in the stem can be eliminated for free, so keep those for
    // last: they only fill in when the text is too thin for four clean options.
    (termRe(term, 'iu').test(stem) ? visible : hidden).push(surface);
  }
  const out = [...hidden, ...visible].slice(0, howMany);
  return out.length === howMany ? out : null; // too few words for four options - ask for a typed answer
}

// --- question building -----------------------------------------------------

// Options read as a list of words, so they all start with a capital letter no matter where
// the word sat in its sentence.
const capFirst = (value) => value.charAt(0).toUpperCase() + value.slice(1);

function makeQuestion(stem, answer, sentence, terms, text, rng, index) {
  const prompt = focused(stem);
  const wrong = pickDistractors(terms, answer, stem, text, rng);
  // Every third question is typed so the quiz mixes both kinds without becoming a typing test.
  if (wrong && index % 3 !== 2) {
    const correct = capFirst(answer);
    const options = shuffle([correct, ...wrong.map(capFirst)], rng);
    const answerIndex = options.indexOf(correct);
    return {
      type: 'mcq', prompt, options, answer_index: answerIndex, answer: options[answerIndex], explanation: sentence,
    };
  }
  return { type: 'cloze', prompt, answer, explanation: sentence };
}

function clampCount(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(MAX_COUNT, Math.max(1, n)) : fallback;
}

// Plain text in, quiz out. Thin material gives fewer questions than asked, honestly,
// and never an exception: the page always gets a usable list.
function buildQuiz(text, { count = 8, seed = 1 } = {}) {
  const source = typeof text === 'string' ? text : '';
  const want = clampCount(count, 8);
  const empty = { questions: [], source: 'local' };
  if (source.trim().length < MIN_TEXT) return empty;
  try {
    const rng = mulberry32(Number.isFinite(Number(seed)) ? Math.trunc(Number(seed)) : 1);
    const sentences = splitSentences(source);
    const terms = keyTerms(source, sentences);
    if (!sentences.length || !terms.length) return empty;

    const questions = [];
    const usedSentences = new Set();
    const usedTerms = new Set();
    const usedPrompts = new Set();

    for (const term of terms) {
      if (questions.length >= want) break;
      const sentence = sentences.find((s) => !usedSentences.has(s) && termRe(term, 'iu').test(s));
      if (!sentence) continue;
      const answer = surfaceOf(sentence, term);
      const stem = masked(sentence, term);
      if (!answer || !stem || usedPrompts.has(normalizeAnswer(stem))) continue;
      const question = makeQuestion(stem, answer, sentence, terms, source, rng, questions.length);
      usedSentences.add(sentence);
      usedTerms.add(term);
      usedPrompts.add(normalizeAnswer(stem));
      questions.push(question);
    }

    // Too few facts for a full quiz: top up with self-check cards. They are never graded,
    // so reusing a sentence is fine and the page still has something to work through.
    for (const term of terms) {
      if (questions.length >= want) break;
      if (usedTerms.has(term)) continue;
      const sentence = sentences.find((s) => termRe(term, 'iu').test(s));
      const answer = surfaceOf(sentence || source, term);
      if (!answer) continue;
      const prompt = `Explain: ${answer}`;
      if (usedPrompts.has(normalizeAnswer(prompt))) continue;
      usedTerms.add(term);
      usedPrompts.add(normalizeAnswer(prompt));
      questions.push({ type: 'selfCheck', prompt, answer: sentence || answer });
    }

    return { questions: questions.map((q, i) => ({ id: `q${i + 1}`, ...q })), source: 'local' };
  } catch {
    return empty;
  }
}

// --- grading ---------------------------------------------------------------

function grade(question, answer) {
  if (!question || typeof question !== 'object') return { correct: false, expected: '' };
  if (question.type === 'selfCheck') return { selfCheck: true };
  const options = Array.isArray(question.options) ? question.options : [];
  const index = Number.isInteger(question.answer_index) ? question.answer_index : -1;
  const expected = String(question.answer || (index >= 0 && options[index]) || '');
  const given = answer === undefined || answer === null ? '' : String(answer).trim();
  if (question.type === 'mcq') {
    // Accept the option text as well as its index, so both a click and a typed reply work.
    const numeric = /^\d+$/.test(given) ? Number(given) : -1;
    const picked = numeric >= 0 ? numeric : options.findIndex((o) => normalizeAnswer(o) === normalizeAnswer(given));
    return { correct: index >= 0 && picked === index, expected };
  }
  const typed = normalizeAnswer(given);
  return { correct: typed !== '' && typed === normalizeAnswer(expected), expected };
}

// --- untrusted (AI) questions ----------------------------------------------

function mcqFrom(item, prompt, explanation) {
  const raw = Array.isArray(item.options) ? item.options : [];
  if (raw.length < MIN_OPTIONS) return null;
  const wanted = Number.isInteger(item.answer_index) ? item.answer_index : -1;
  const options = [];
  const seen = new Set();
  let answerIndex = -1;
  for (let i = 0; i < raw.length && options.length < MAX_OPTIONS; i += 1) {
    const text = typeof raw[i] === 'string' || typeof raw[i] === 'number' ? String(raw[i]).trim() : '';
    const key = normalizeAnswer(text);
    if (!key) continue;
    if (seen.has(key)) {
      if (i === wanted) return null; // the real answer was a duplicate - we cannot tell which one is right
      continue;
    }
    seen.add(key);
    options.push(text);
    if (i === wanted) answerIndex = options.length - 1;
  }
  if (answerIndex < 0) {
    const fallback = typeof item.answer === 'string' ? normalizeAnswer(item.answer) : '';
    if (fallback) answerIndex = options.findIndex((o) => normalizeAnswer(o) === fallback);
  }
  if (answerIndex < 0 || options.length < MIN_OPTIONS) return null;
  return { type: 'mcq', prompt, options, answer_index: answerIndex, answer: options[answerIndex], explanation };
}

function normalizeQuestion(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = typeof item.prompt === 'string' ? item.prompt : typeof item.question === 'string' ? item.question : '';
  const prompt = String(raw).replace(/\s+/gu, ' ').trim();
  if (prompt.length < MIN_PROMPT) return null;
  const explanation = typeof item.explanation === 'string' ? item.explanation.trim().slice(0, 400) : '';
  const answer = typeof item.answer === 'string' || typeof item.answer === 'number' ? String(item.answer).trim() : '';
  const mcq = mcqFrom(item, prompt, explanation);
  if (mcq) return mcq;
  if (!answer) return null;
  return { type: item.type === 'selfCheck' ? 'selfCheck' : 'cloze', prompt, answer, explanation };
}

// Accepts whatever the AI route hands over - {questions}, {quiz} or a bare array - and returns
// clean questions in the same shape the local engine produces, so the page has one format.
function normalizeQuiz(input, { max = MAX_QUESTIONS } = {}) {
  const cap = clampCount(max, MAX_QUESTIONS);
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (input && typeof input === 'object') {
    if (Array.isArray(input.questions)) list = input.questions;
    else if (Array.isArray(input.quiz)) list = input.quiz;
  }
  const out = [];
  for (const item of list) {
    if (out.length >= cap) break;
    const question = normalizeQuestion(item);
    if (question) out.push({ id: `q${out.length + 1}`, ...question });
  }
  return out;
}

module.exports = { buildQuiz, grade, normalizeQuiz, MIN_TEXT };
