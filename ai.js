// Studay AI-assisted feature - Member C (AI Integration)
// Offline extractive MVP. Drop-in point for an LLM API (see bottom).
// Modes: 'summary' | 'flashcards' | 'quiz' | 'all'. Unknown modes fall back to 'all'.

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

function generateStudyAids(text, mode = 'all') {
  const out = {};
  const m = ['summary', 'flashcards', 'quiz'].includes(mode) ? mode : 'all';
  if ((m === 'all' || m === 'summary') && text.trim().length >= 30) out.summary = summarize(text);
  if ((m === 'all' || m === 'flashcards') && text.trim().length >= 30) out.flashcards = makeFlashcards(text);
  if (m === 'all' || m === 'quiz') out.quiz = makeQuiz(text);
  return out;
}

// --- To upgrade to a real LLM later (OpenAI example), replace the body of
// --- generateStudyAids with a fetch call:
// const res = await fetch('https://api.openai.com/v1/chat/completions', {
//   method: 'POST',
//   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
//   body: JSON.stringify({ model: 'gpt-4o-mini',
//     messages: [{ role: 'user', content: `From these study notes, produce a summary, 5 flashcards, and 3 quiz questions:\n\n${text}` }] }),
// });
// const data = await res.json();
// return { raw: data.choices[0].message.content };

module.exports = { generateStudyAids };
