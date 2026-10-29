// Google Gemini client. Called only from the server; the key never reaches the browser.
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
// Long notes and PDFs can take a while; override with GEMINI_TIMEOUT_MS.
const TIMEOUT_MS = 60000;

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
    quiz: '"quiz": [{"question": string, "options": string[4], "answer_index": number, "explanation": string}] (5 questions)',
  };
  const keys = want[mode] ? [mode] : Object.keys(want);
  return 'You are a study assistant. Using ONLY the notes below, return a JSON object with these keys:\n'
    + keys.map((k) => `- ${want[k]}`).join('\n')
    + '\nWrite in the same language as the notes. Do not invent facts.\n\nNOTES:\n'
    + text;
}

// Low-level call: `parts` is a Gemini content array, e.g. [{ text }] or
// [{ text }, { inline_data: { mime_type, data } }] for an image or a PDF.
// Always asks for JSON and returns the parsed object.
async function requestJson(parts, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, temperature = 0.3 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new AiError('timeout', 'AI request timed out');
    throw new AiError('upstream', `AI request failed: ${err.message}`);
  }

  if (res.status === 429) throw new AiError('rate_limited', 'AI quota exceeded', 429);
  if (!res.ok) {
    // Google explains the failure (bad key, model not found, ...) in the body; keep a short slice for the server log.
    const body = res.text ? await res.text().catch(() => '') : '';
    throw new AiError('upstream', `AI returned HTTP ${res.status}: ${body.slice(0, 300)}`, res.status);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw || !raw.trim()) throw new AiError('empty', 'AI returned an empty response');

  try {
    return JSON.parse(raw);
  } catch {
    throw new AiError('bad_output', 'AI returned invalid JSON');
  }
}

// Study aids (summary / quiz) from plain text.
const callGemini = (text, mode, opts) => requestJson([{ text: buildPrompt(text, mode) }], opts);

module.exports = { callGemini, requestJson, AiError, buildPrompt, DEFAULT_MODEL };
