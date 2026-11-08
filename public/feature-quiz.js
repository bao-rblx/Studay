// Feature: quiz. One question at a time, instant feedback, score at the end.
// The quiz wave replaces the body of this file.
window.Studay.register('quiz', {
  init() {
    $('quiz-start').addEventListener('click', () => {
      const sid = Number($('quiz-subject').value);
      if (!sid) return toast('Add a subject first');
      quizFrom({ subject_id: sid });
    });
  },
  render() { renderQuizHistory(); },
});

let quizQs = [], quizIdx = 0, quizScore = 0;
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map(([, v]) => v);

async function quizFrom(source) {
  go('quiz');
  $('quiz-box').innerHTML = '<div class="ai-loading">Writing your quiz...</div>';
  let out;
  try { out = await send('/api/ai/quiz', source); } catch { $('quiz-box').innerHTML = ''; return; }
  quizQs = (out.quiz || []).map((q) => ({ ...q, answer: q.options[q.answer_index], options: shuffle(q.options) }));
  quizIdx = 0; quizScore = 0;
  if (!quizQs.length) { $('quiz-box').innerHTML = aiNotice(out) + '<p class="hint">No questions this time. Add more notes or files.</p>'; return; }
  $('quiz-box').dataset.intro = aiNotice(out) + aiSource(out);
  showQuiz();
}

function showQuiz() {
  if (quizIdx >= quizQs.length) {
    const log = store.get('sd_quizzes', []);
    log.unshift({ date: new Date().toLocaleString(), score: `${quizScore}/${quizQs.length}` });
    store.set('sd_quizzes', log.slice(0, 10));
    addXP(quizScore * 5);
    $('quiz-box').innerHTML = `<div class="panel"><h3>Done! ${quizScore}/${quizQs.length} (+${quizScore * 5} XP)</h3>
      <button onclick="this.closest('.view').querySelector('#quiz-start').click()">Another quiz</button></div>`;
    renderQuizHistory(); return;
  }
  const q = quizQs[quizIdx];
  $('quiz-box').innerHTML = `${$('quiz-box').dataset.intro || ''}<div class="panel"><div class="quiz-q">${esc(q.question)} <small>(${quizIdx + 1}/${quizQs.length})</small></div>
    ${q.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${esc(o)}</button>`).join('')}<div id="quiz-expl"></div></div>`;
  document.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => {
    const picked = q.options[Number(b.dataset.i)];
    document.querySelectorAll('.quiz-opt').forEach((x) => {
      x.disabled = true;
      if (q.options[Number(x.dataset.i)] === q.answer) x.classList.add('correct');
    });
    if (picked === q.answer) quizScore++; else b.classList.add('wrong');
    $('quiz-expl').innerHTML = `${q.explanation ? `<p class="hint">${esc(q.explanation)}</p>` : ''}<button id="quiz-next">Next</button>`;
    $('quiz-next').addEventListener('click', () => { quizIdx++; showQuiz(); });
  }));
}

function renderQuizHistory() {
  const log = store.get('sd_quizzes', []);
  $('quiz-history').innerHTML = log.length ? '<h3>Recent quizzes</h3>' + log.map((l) => `<div class="up-item"><span>${esc(l.date)}</span><strong>${esc(l.score)}</strong></div>`).join('') : '';
}
