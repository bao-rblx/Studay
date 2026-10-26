// Google Gemini client. Called only from the server; the key never reaches the browser.
const DEFAULT_MODEL = 'gemini-2.5-flash';
const TIMEOUT_MS = 10000;

class AiError extends Error {
  constructor(kind, message, status) {
    super(message);
    this.kind = kind; // 'rate_limited' | 'timeout' | 'upstream' | 'empty' | 'bad_output'
    this.status = status;
  }
}

function buildPrompt(text, mode) {
  const want = {
    summary: '"summary": {"summary": string, "key_points": string[]}',
    flashcards: '"flashcards": [{"front": string, "back": string}] (5 cards)',
    quiz: '"quiz": [{"question": string, "options": string[3], "answer_index": number, "explanation": string}] (3 questions)',
  };
  const keys = mode === 'all' ? Object.keys(want) : [mode];
  return 'You are a study assistant. Using ONLY the notes below, return a JSON object with these keys:\n'
    + keys.map((k) => `- ${want[k]}`).join('\n')
    + '\nWrite in the same language as the notes. Do not invent facts.\n\nNOTES:\n'
    + text;
}

async function callGemini(text, mode, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(text, mode) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new AiError('timeout', 'AI request timed out');
    throw new AiError('upstream', `AI request failed: ${err.message}`);
  }

  if (res.status === 429) throw new AiError('rate_limited', 'AI quota exceeded', 429);
  if (!res.ok) throw new AiError('upstream', `AI returned HTTP ${res.status}`, res.status);

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw || !raw.trim()) throw new AiError('empty', 'AI returned an empty response');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiError('bad_output', 'AI returned invalid JSON');
  }
  return parsed;
}

module.exports = { callGemini, AiError, buildPrompt, DEFAULT_MODEL };
