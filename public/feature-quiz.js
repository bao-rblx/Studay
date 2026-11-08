// Feature: quiz. One question at a time, built from this account's own notes.
// The local engine (src/quiz.js) writes the questions, so the page works without an AI key.
// Multiple choice is graded here; typed answers go to POST /api/quiz/check so the forgiving
// diacritic/spacing rules stay in one place on the server.
const QUIZ_COUNT = 8;
const BEST_KEY = 'sd_quiz_best';
const BLANK = '_____';
let run = null; // { title, subjectId, questions, index, correct, missed, done }
let wired = false;

window.Studay.register('quiz', {
  init() {
    run = null;
    if (wired) return;
    wired = true;
    $('quiz-start').addEventListener('click', startSelected);
    // Picking another subject shows what it has, but never throws away a quiz in progress.
    $('quiz-subject').addEventListener('change', () => {
      if (run && !run.done) return;
      run = null;
      renderBest();
      showIntro();
    });
  },
  render() {
    renderBest();
    if (!run) showIntro();
  },
});

// Called from "Quiz me on this" on a file, with { material_id } or { subject_id }.
function quizFrom(source) { return startQuiz(source); }

// A fresh seed each round: the same notes give a different quiz, the same seed a repeatable one.
const nextSeed = () => (Date.now() % 100000) + 1;
const stockOf = (id) => ({
  notes: state.notes.filter((n) => n.subject_id === id).length,
  files: state.materials.filter((m) => m.subject_id === id).length,
});
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const blanked = (text) => esc(text).split(BLANK).join(`<span class="quiz-blank">${BLANK}</span>`);

// ---------- screens ----------

function card(inner) { return `<div class="panel quiz-card">${inner}</div>`; }

function showIntro() {
  const box = $('quiz-box');
  const sid = Number($('quiz-subject').value);
  if (!state.subjects.length) {
    box.innerHTML = card(`<h3>No subject yet</h3>
      <p class="hint">A quiz is built from your own notes, so start with a subject and one note.</p>
      <button type="button" onclick="go('subjects')">Add a subject</button>`);
    return;
  }
  const subject = subjectOf(sid);
  const stock = subject ? stockOf(subject.id) : { notes: 0, files: 0 };
  if (!subject || stock.notes + stock.files === 0) {
    box.innerHTML = card(`<h3>Nothing to quiz on yet</h3>
      <p class="hint">${subject ? esc(subject.name) : 'This subject'} has no notes or files. A paragraph of text
        is enough to make questions from.</p>
      <div class="row-actions">
        <button type="button" onclick="go('notes')">Write a note</button>
        <button type="button" class="ghost" onclick="go('buddy')">Add a file</button>
      </div>`);
    return;
  }
  const best = bestOf(subject.id);
  box.innerHTML = card(`<h3>Ready when you are</h3>
    <p class="hint">${esc(subject.name)}: ${plural(stock.notes, 'note', 'notes')} and
      ${plural(stock.files, 'file', 'files')}. One question at a time, no timer.</p>
    <button type="button" id="quiz-big-start">Start ${QUIZ_COUNT} questions</button>
    ${best ? `<p class="quiz-best-note">Your best: ${best.score}/${best.total}</p>` : ''}`);
  $('quiz-big-start').addEventListener('click', startSelected);
}

function thinCard(message) {
  return card(`<h3>Not enough to quiz on yet</h3>
    <p class="quiz-error">${esc(message)}</p>
    <div class="row-actions">
      <button type="button" onclick="go('notes')">Write a note</button>
      <button type="button" class="ghost" onclick="go('buddy')">Add a file</button>
    </div>`);
}

function startSelected() {
  const sid = Number($('quiz-subject').value);
  if (!sid) return toast('Add a subject first');
  startQuiz({ subject_id: sid });
}

async function startQuiz(source) {
  go('quiz');
  $('quiz-box').innerHTML = '<div class="ai-loading">Writing questions from your notes...</div>';
  let out;
  try {
    out = await send('/api/quiz', { ...source, count: QUIZ_COUNT, seed: nextSeed() });
  } catch (err) {
    // api() already explained the real problem; keep the card usable either way.
    const message = err && err.message && err.message.length > 15
      ? err.message
      : 'I could not build a quiz just now. Try again in a moment.';
    $('quiz-box').innerHTML = thinCard(message);
    return;
  }
  run = {
    title: out.title || 'Quiz',
    subjectId: out.subject_id || null,
    source,
    questions: out.questions || [],
    index: 0,
    correct: 0,
    missed: [],
    done: false,
  };
  if (!run.questions.length) {
    run = null;
    $('quiz-box').innerHTML = thinCard('That material had no usable questions - add a longer note.');
    return;
  }
  paintQuestion();
}

function paintQuestion() {
  const q = run.questions[run.index];
  const total = run.questions.length;
  const step = run.index + 1;
  const pct = Math.round((run.index / total) * 100);
  let answerArea = '';
  if (q.type === 'mcq') {
    answerArea = `<div class="quiz-options">${q.options
      .map((o, i) => `<button type="button" class="quiz-opt" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
  } else if (q.type === 'cloze') {
    answerArea = `<form class="quiz-typing" id="quiz-typing">
      <input id="quiz-answer" placeholder="Type the missing word" autocomplete="off" autocapitalize="off"
        spellcheck="false" aria-label="Your answer" required>
      <button type="submit" id="quiz-check">Check</button></form>`;
  } else {
    answerArea = `<div class="quiz-selfcheck">
      <p class="hint">Say it out loud or jot it down - this one is not graded.</p>
      <button type="button" id="quiz-reveal" class="ghost">Show the answer</button></div>`;
  }
  $('quiz-box').innerHTML = card(`<div class="quiz-head">
      <span class="quiz-step">${step} / ${total}</span>
      <span class="quiz-meta">${esc(run.title)} · ${run.correct} correct</span>
    </div>
    <div class="quiz-track" aria-hidden="true"><span style="width:${pct}%"></span></div>
    <p class="quiz-q">${blanked(q.prompt)}</p>
    ${answerArea}
    <div class="quiz-feedback" id="quiz-feedback" aria-live="polite"></div>`);

  if (q.type === 'mcq') {
    document.querySelectorAll('#quiz-box .quiz-opt').forEach((btn) => {
      btn.addEventListener('click', () => answerMcq(q, Number(btn.dataset.i)));
    });
  } else if (q.type === 'cloze') {
    $('quiz-typing').addEventListener('submit', submitTyped);
    $('quiz-answer').focus();
  } else {
    $('quiz-reveal').addEventListener('click', revealSelf);
  }
}

// ---------- answering ----------

function answerMcq(q, picked) {
  document.querySelectorAll('#quiz-box .quiz-opt').forEach((btn) => {
    const i = Number(btn.dataset.i);
    btn.disabled = true;
    if (i === q.answer_index) btn.classList.add('correct');
    else if (i === picked) btn.classList.add('wrong');
  });
  settle(q, picked === q.answer_index);
}

async function submitTyped(event) {
  event.preventDefault();
  const q = run.questions[run.index];
  const input = $('quiz-answer');
  const btn = $('quiz-check');
  const typed = input.value.trim();
  if (!typed) return input.focus();
  btn.disabled = true;
  btn.textContent = 'Checking...';
  let out;
  try {
    // Only what grading needs travels back, not the whole question.
    out = await send('/api/quiz/check', {
      question: { type: q.type, prompt: q.prompt, answer: q.answer },
      answer: typed,
    });
  } catch {
    btn.disabled = false;
    btn.textContent = 'Check';
    return;
  }
  input.disabled = true;
  btn.textContent = 'Checked';
  settle(q, Boolean(out.correct), typed);
}

// Mark the question done and show the answer straight away.
function settle(q, ok, typed = '') {
  if (ok) run.correct += 1;
  else run.missed.push(q);
  $('quiz-feedback').innerHTML = `<div class="quiz-result ${ok ? 'ok' : 'no'}">
      <strong>${ok ? '✅ Correct' : '❌ Not quite'}</strong>
      ${ok ? '' : `<span>The answer is <b>${esc(q.answer)}</b></span>`}
      ${!ok && typed ? `<small class="hint">You wrote "${esc(typed)}"</small>` : ''}
      ${q.explanation ? `<p class="hint">${esc(q.explanation)}</p>` : ''}
    </div>
    <button type="button" class="quiz-next" id="quiz-next">${nextLabel()}</button>`;
  $('quiz-next').addEventListener('click', nextQuestion);
  $('quiz-next').focus();
}

function revealSelf() {
  const q = run.questions[run.index];
  $('quiz-feedback').innerHTML = `<div class="quiz-result ok">
      <strong>📖 From your notes</strong><p>${esc(q.answer)}</p>
    </div>
    <button type="button" class="quiz-next" id="quiz-next">${nextLabel()}</button>`;
  $('quiz-reveal').disabled = true;
  $('quiz-next').addEventListener('click', nextQuestion);
  $('quiz-next').focus();
}

const nextLabel = () => (run.index + 1 >= run.questions.length ? 'See my score' : 'Next question');

function nextQuestion() {
  run.index += 1;
  if (run.index >= run.questions.length) finish();
  else paintQuestion();
}

// ---------- score screen ----------

function finish() {
  run.done = true;
  const total = run.questions.length;
  const score = run.correct;
  const source = run.source; // "one more quiz" repeats the same file or subject
  const record = saveBest(run.subjectId, score, total);
  if (score) addXP(score * 5);
  $('quiz-box').innerHTML = card(`<div class="quiz-score">
      <span class="quiz-score-big">${score}<span>/${total}</span></span>
      <p class="hint">${praise(score, total)}</p>
    </div>
    ${record.newBest ? '<p class="quiz-badge">🏅 New best for this subject</p>' : ''}
    <div class="quiz-actions">
      ${run.missed.length ? `<button type="button" id="quiz-retry">Practise the ${run.missed.length} I missed</button>` : ''}
      <button type="button" id="quiz-again" class="${run.missed.length ? 'ghost' : ''}">One more quiz</button>
    </div>
    ${record.line ? `<p class="quiz-best-note">${esc(record.line)}</p>` : ''}`);
  if (run.missed.length) $('quiz-retry').addEventListener('click', retryMissed);
  $('quiz-again').addEventListener('click', () => startQuiz(source));
  renderBest();
}

function retryMissed() {
  run = { ...run, questions: run.missed, index: 0, correct: 0, missed: [], done: false };
  paintQuestion();
}

const praise = (score, total) => {
  const pct = total ? score / total : 0;
  if (pct === 1) return 'Perfect run - you know this material.';
  if (pct >= 0.75) return 'Strong result. The missed ones are worth a quick look.';
  if (pct >= 0.5) return 'Halfway there. Read the notes once more and run it again.';
  return 'Tough round. Skim the notes, then retry the ones you missed.';
};

// Best score is kept per subject in localStorage, so it survives a refresh without a table.
function bestOf(subjectId) { return subjectId ? store.get(BEST_KEY, {})[subjectId] || null : null; }

function saveBest(subjectId, score, total) {
  const name = subjectOf(subjectId)?.name || 'this subject';
  const all = store.get(BEST_KEY, {});
  const prev = bestOf(subjectId);
  // Compare fractions, so a short retry round cannot beat a full quiz it did worse on.
  const better = Boolean(subjectId) && (!prev || score * prev.total > prev.score * total);
  if (better) {
    all[subjectId] = { score, total, at: new Date().toISOString().slice(0, 10) };
    store.set(BEST_KEY, all);
  }
  const best = better ? all[subjectId] : prev;
  return {
    newBest: better && score > 0,
    line: best ? `Best for ${name}: ${best.score}/${best.total}` : '',
  };
}

function renderBest() {
  const all = store.get(BEST_KEY, {});
  const rows = state.subjects.filter((s) => all[s.id]).map((s) => {
    const best = all[s.id];
    return `<div class="up-item" style="--c:${esc(s.color || '#007aff')}">
      <span><strong>${esc(s.name)}</strong> <small>best ${best.score}/${best.total}</small></span>
      <span class="quiz-best-score">${Math.round((best.score / best.total) * 100)}%</span></div>`;
  });
  $('quiz-history').innerHTML = rows.length ? `<h3>Your best scores</h3>${rows.join('')}` : '';
}
