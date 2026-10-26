// Studay frontend.
const $ = (id) => document.getElementById(id);
// Every API call goes through here so failures show a message instead of breaking the page.
async function api(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    showBanner('Cannot reach the server. Check your connection and try again.');
    throw new Error('network');
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 503) {
    showBanner('The database is waking up (free tier). Retrying in 10 seconds...');
    setTimeout(() => refresh().catch(() => {}), 10000);
    throw new Error('db_down');
  }
  if (!res.ok) {
    toast(body.error || `Request failed (${res.status})`);
    throw new Error(body.error || String(res.status));
  }
  hideBanner();
  return body;
}
function showBanner(msg) { const b = $('status-banner'); b.textContent = msg; b.classList.remove('hidden'); }
function hideBanner() { $('status-banner').classList.add('hidden'); }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get: (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

let subjects = [], notes = [], cards = [];
let modalCtx = null;

// ---------- toast, XP, streak ----------
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2200); }
function addXP(n) { const xp = store.get('sd_xp', 0) + n; store.set('sd_xp', xp); $('xp-val').textContent = xp; $('xp-fill').style.width = Math.min(100, xp % 100) + '%'; }
function touchStreak() {
  const today = new Date().toDateString();
  const last = store.get('sd_last', '');
  let streak = store.get('sd_streak', 0);
  if (last !== today) {
    const y = new Date(Date.now() - 864e5).toDateString();
    streak = (last === y) ? streak + 1 : 1;
    store.set('sd_streak', streak); store.set('sd_last', today);
  }
  $('streak-val').textContent = store.get('sd_streak', 0);
}

// ---------- navigation ----------
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.nav-btn').forEach((x) => x.classList.remove('active'));
  document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('view-' + b.dataset.view).classList.add('active');
}));
$('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  store.set('sd_theme', document.body.classList.contains('dark') ? 'dark' : 'light');
  $('theme-toggle').textContent = document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode';
});

// ---------- data loading ----------
async function refresh() {
  subjects = await api('/api/subjects');
  notes = await api('/api/notes');
  cards = await api('/api/flashcards');
  renderAll();
}
function renderAll() {
  renderStats(); renderSubjects(); renderNotes(); renderCards();
  renderAiNotes(); renderQuizNotes(); renderRecent(); renderDeadlines(); renderQuizHistory();
  $('xp-val').textContent = store.get('sd_xp', 0);
}
function renderStats() {
  $('stat-subjects').textContent = subjects.length;
  $('stat-notes').textContent = notes.length;
  $('stat-cards').textContent = cards.length;
  $('stat-quiz').textContent = store.get('sd_quizzes', []).length;
}

// ---------- subjects ----------
function renderSubjects() {
  $('subject-list').innerHTML = subjects.map((s) => {
    const n = notes.filter((x) => x.subject_id === s.id).length;
    return `<div class="subject-tile" style="border-color:${esc(s.color)}">
      <strong>${esc(s.name)}</strong> <span>(${n} notes)</span>
      <div class="row-actions">
        <button onclick="filterNotesBy(${s.id})">View notes</button>
        <button onclick="openEditSubject(${s.id})" class="ghost">Edit</button>
        <button onclick="delSubject(${s.id})" class="danger">Delete</button>
      </div></div>`;
  }).join('') || '<p>No subjects yet. Add one above.</p>';
  const opts = subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  $('note-subject').innerHTML = opts;
  $('quick-note-subject').innerHTML = opts;
  $('notes-filter-subject').innerHTML = '<option value="">All subjects</option>' + opts;
}
$('subject-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/subjects', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: $('subject-name').value, color: $('subject-color').value }) });
  $('subject-name').value = ''; addXP(5); toast('Subject added +5 XP'); refresh();
});
async function delSubject(id) { if (!confirm('Delete subject and its notes?')) return; await fetch(`/api/subjects/${id}`, { method: 'DELETE' }); refresh(); }
function openEditSubject(id) { const s = subjects.find((x) => x.id === id); openModal('Edit subject', s.name, '', async (a) => {
  await api(`/api/subjects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: a }) }); refresh(); }); }

// ---------- notes ----------
function getFilteredNotes() {
  let list = [...notes];
  const f = $('notes-filter-subject').value;
  if (f) list = list.filter((n) => String(n.subject_id) === String(f));
  const q = ($('global-search').value || '').toLowerCase();
  if (q) list = list.filter((n) => (n.title + ' ' + n.content).toLowerCase().includes(q));
  const sort = $('notes-sort').value;
  if (sort === 'az') list.sort((a, b) => a.title.localeCompare(b.title));
  else if (sort === 'old') list.sort((a, b) => a.id - b.id);
  else list.sort((a, b) => b.id - a.id);
  return list;
}
function renderNotes() {
  const list = getFilteredNotes();
  $('note-list').innerHTML = list.map((n) => {
    const subj = subjects.find((s) => s.id === n.subject_id);
    const cc = cards.filter((c) => c.note_id === n.id).length;
    const preview = esc(n.content).slice(0, 220);
    return `<div class="note"><strong>${esc(n.title)}</strong>
      <div><small>${esc(subj?.name || '')} • ${cc} cards</small></div>
      <p>${preview}${n.content.length > 220 ? '...' : ''}</p>
      <div class="row-actions">
        <button onclick="aiFromNote(${n.id})">AI generate</button>
        <button onclick="copyNote(${n.id})" class="ghost">Copy</button>
        <button onclick="openEditNote(${n.id})" class="ghost">Edit</button>
        <button onclick="delNote(${n.id})" class="danger">Delete</button>
      </div></div>`;
  }).join('') || '<p>No notes match.</p>';
  $('cards-filter-note').innerHTML = '<option value="">All decks</option>' + notes.map((n) => `<option value="${n.id}">${esc(n.title)}</option>`).join('');
}
function filterNotesBy(subjectId) {
  document.querySelector('[data-view="notes"]').click();
  $('notes-filter-subject').value = subjectId; renderNotes();
}
$('notes-filter-subject').addEventListener('change', renderNotes);
$('notes-sort').addEventListener('change', renderNotes);
$('global-search').addEventListener('input', () => { renderNotes(); });
$('export-notes').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'studay-notes.json'; a.click();
  toast('Notes exported');
});
$('note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: Number($('note-subject').value), title: $('note-title').value, content: $('note-content').value }) });
  $('note-title').value = ''; $('note-content').value = ''; addXP(10); toast('Note saved +10 XP'); refresh();
});
$('quick-note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject_id: Number($('quick-note-subject').value), title: $('quick-note-title').value, content: $('quick-note-content').value }) });
  $('quick-note-title').value = ''; $('quick-note-content').value = '';
  addXP(10); refresh(); aiFromNote(r.id);
});
async function delNote(id) { if (!confirm('Delete this note and its flashcards?')) return; await fetch(`/api/notes/${id}`, { method: 'DELETE' }); refresh(); }
async function copyNote(id) { const n = notes.find((x) => x.id === id); await navigator.clipboard.writeText(n.title + '\n\n' + n.content); toast('Note copied'); }
function openEditNote(id) { const n = notes.find((x) => x.id === id); openModal('Edit note', n.title, n.content, async (a, b) => {
  await api(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: a, content: b }) }); refresh(); }); }

// ---------- flashcards + study mode ----------
let studyDeck = [], studyIdx = 0, studyFlipped = false, studyScore = 0;
function renderCards() {
  const f = $('cards-filter-note').value;
  let list = f ? cards.filter((c) => String(c.note_id) === String(f)) : cards;
  const q = ($('global-search').value || '').toLowerCase();
  if (q) list = list.filter((c) => (c.front + ' ' + c.back).toLowerCase().includes(q));
  $('card-list').innerHTML = list.map((c) =>
    `<div class="card"><div>${esc(c.front)}</div><div style="color:var(--brand);margin-top:.4rem">${esc(c.back)}</div>
     <div class="row-actions"><button onclick="delCard(${c.id})" class="danger">Delete</button></div></div>`
  ).join('') || '<p>No flashcards yet — generate some with the AI.</p>';
}
$('cards-filter-note').addEventListener('change', renderCards);
$('shuffle-cards').addEventListener('click', () => { cards.sort(() => Math.random() - .5); renderCards(); toast('Shuffled'); });
async function delCard(id) { await fetch(`/api/flashcards/${id}`, { method: 'DELETE' }); refresh(); }
$('study-mode-btn').addEventListener('click', () => {
  const f = $('cards-filter-note').value;
  studyDeck = (f ? cards.filter((c) => String(c.note_id) === String(f)) : [...cards]).sort(() => Math.random() - .5);
  if (!studyDeck.length) return toast('No cards to study');
  studyIdx = 0; studyScore = 0; studyFlipped = false;
  $('study-mode').classList.remove('hidden'); showStudy(); addXP(5);
});
function showStudy() {
  const c = studyDeck[studyIdx];
  $('study-text').textContent = studyFlipped ? c.back : c.front;
  $('study-progress').textContent = `Card ${studyIdx + 1}/${studyDeck.length} • Score ${studyScore}`;
}
$('study-flip').addEventListener('click', () => { studyFlipped = !studyFlipped; showStudy(); });
$('study-card').addEventListener('click', () => { studyFlipped = !studyFlipped; showStudy(); });
$('study-next').addEventListener('click', () => { studyIdx = (studyIdx + 1) % studyDeck.length; studyFlipped = false; showStudy(); });
$('study-knew').addEventListener('click', () => { studyScore++; addXP(3); studyIdx = (studyIdx + 1) % studyDeck.length; studyFlipped = false; showStudy(); });
$('study-review').addEventListener('click', () => { studyDeck.push(studyDeck[studyIdx]); studyIdx = (studyIdx + 1) % studyDeck.length; studyFlipped = false; showStudy(); toast('Will review again'); });
$('study-exit').addEventListener('click', () => { $('study-mode').classList.add('hidden'); toast(`Study done! Score ${studyScore}`); });

// ---------- quiz ----------
let quizQs = [], quizIdx = 0, quizScore = 0;
function renderQuizNotes() { $('quiz-note').innerHTML = notes.map((n) => `<option value="${n.id}">${esc(n.title)}</option>`).join(''); }
$('quiz-start').addEventListener('click', async () => {
  const noteId = $('quiz-note').value;
  if (!noteId) return toast('Save a note first');
  const out = await api('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note_id: Number(noteId), mode: 'quiz' }) });
  quizQs = (out.quiz || []).map((q) => ({ ...q, _answer: q.options[q.answer_index], options: [...q.options].sort(() => Math.random() - .5) }));
  quizIdx = 0; quizScore = 0; showQuiz();
});
function showQuiz() {
  if (quizIdx >= quizQs.length) {
    const log = store.get('sd_quizzes', []);
    log.unshift({ date: new Date().toLocaleString(), score: `${quizScore}/${quizQs.length}` });
    store.set('sd_quizzes', log.slice(0, 10));
    addXP(quizScore * 5);
    $('quiz-box').innerHTML = `<div class="panel"><h3>Done! Score ${quizScore}/${quizQs.length} (+${quizScore * 5} XP)</h3><button onclick="document.getElementById('quiz-start').click()">Retry</button></div>`;
    renderQuizHistory(); return;
  }
  const q = quizQs[quizIdx];
  $('quiz-box').innerHTML = `<div class="panel"><div class="quiz-q">${esc(q.question)} (${quizIdx + 1}/${quizQs.length})</div>
    ${q.options.map((o, i) => `<button class="quiz-opt" data-i="${i}">${esc(o)}</button>`).join('')}</div>`;
  document.querySelectorAll('.quiz-opt').forEach((b) => b.addEventListener('click', () => {
    const isRight = b.textContent === q._answer;
    document.querySelectorAll('.quiz-opt').forEach((x) => {
      if (x.textContent === q._answer) x.classList.add('correct');
    });
    if (!isRight) b.classList.add('wrong'); else quizScore++;
    setTimeout(() => { quizIdx++; showQuiz(); }, 1200);
  }));
}
function renderQuizHistory() {
  const log = store.get('sd_quizzes', []);
  $('quiz-history').innerHTML = log.length ? '<h3>Recent quizzes</h3>' + log.map((l) => `<div class="deadline-item"><span>${esc(l.date)}</span><strong>${esc(l.score)}</strong></div>`).join('') : '';
}

// ---------- AI studio ----------
function renderAiNotes() { $('ai-note').innerHTML = notes.map((n) => `<option value="${n.id}">${esc(n.title)}</option>`).join(''); }
async function aiFromNote(noteId) {
  document.querySelector('[data-view="ai"]').click();
  $('ai-note').value = noteId;
  runAi({ note_id: Number(noteId), mode: 'all' });
}
async function runAi(payload) {
  $('ai-output').innerHTML = '<div class="ai-loading">Distilling your notes...</div>';
  let out;
  try {
    out = await api('/api/ai/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch {
    $('ai-output').innerHTML = '<div class="ai-block ai-notice">Could not generate study aids right now. Your note is safe - try again in a moment.</div>';
    return;
  }
  if ((out.flashcards || []).length && payload.note_id) {
    for (const f of out.flashcards) {
      await api('/api/flashcards', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note_id: payload.note_id, front: f.front, back: f.back }) });
    }
    const fresh = await api('/api/flashcards'); cards = fresh;
  }
  // stash answer text for quiz buttons
  (out.quiz || []).forEach((q) => { q._answer = q.options[q.answer_index]; });
  let html = '';
  if (out.notice) html += `<div class="ai-block ai-notice">${esc(out.notice)}</div>`;
  html += `<p class="ai-source">Generated by: ${out.source === 'gemini' ? 'Google Gemini' : 'offline generator'}</p>`;
  if (out.summary) html += `<div class="ai-block"><h3>Summary</h3><p>${esc(out.summary.summary)}</p><h4>Key points</h4><ul>${out.summary.key_points.map((k) => `<li>${esc(k)}</li>`).join('')}</ul></div>`;
  if (out.flashcards) html += `<div class="ai-block"><h3>Flashcards (${out.flashcards.length} saved)</h3>${out.flashcards.map((f) => `<p><strong>${esc(f.front)}</strong><br>${esc(f.back)}</p>`).join('')}</div>`;
  if (out.quiz) { quizQs = out.quiz.map((q) => ({ ...q, options: [...q.options].sort(() => Math.random() - .5) })); html += `<div class="ai-block"><h3>Quiz ready</h3><p>${out.quiz.length} questions generated from this note. <button onclick="document.querySelector('[data-view=quiz]').click()">Go to Quiz tab</button></p></div>`; }
  $('ai-output').innerHTML = html;
  renderCards(); renderStats(); addXP(15); toast('AI generated +15 XP');
}
$('ai-run').addEventListener('click', () => {
  const noteId = $('ai-note').value;
  if (!noteId) return toast('Save a note first');
  runAi({ note_id: Number(noteId), mode: $('ai-mode').value });
});
$('ai-run-paste').addEventListener('click', () => {
  const t = $('ai-paste').value.trim();
  if (t.length < 30) return toast('Paste at least a paragraph');
  runAi({ content: t, mode: $('ai-mode').value });
});

// ---------- recent, deadlines ----------
function renderRecent() {
  $('recent-list').innerHTML = [...notes].sort((a, b) => b.id - a.id).slice(0, 3).map((n) =>
    `<div class="deadline-item"><span>${esc(n.title)}</span><button class="ghost" onclick="aiFromNote(${n.id})">AI</button></div>`).join('') || '<p>Nothing yet.</p>';
}
function renderDeadlines() {
  const list = store.get('sd_deadlines', []);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  $('deadline-list').innerHTML = list.map((d, i) => {
    const days = Math.ceil((new Date(d.date) - now) / 864e5);
    const urgent = days <= 3 ? 'urgent' : '';
    return `<div class="deadline-item ${urgent}"><span>${esc(d.title)} — ${esc(d.date)} (${days}d)</span><button class="danger" onclick="delDeadline(${i})">x</button></div>`;
  }).join('') || '<p>No deadlines.</p>';
}
$('deadline-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const list = store.get('sd_deadlines', []);
  list.push({ title: $('deadline-title').value, date: $('deadline-date').value });
  list.sort((a, b) => a.date.localeCompare(b.date));
  store.set('sd_deadlines', list);
  $('deadline-title').value = ''; $('deadline-date').value = '';
  renderDeadlines(); toast('Deadline added');
});
function delDeadline(i) { const list = store.get('sd_deadlines', []); list.splice(i, 1); store.set('sd_deadlines', list); renderDeadlines(); }

// ---------- timer ----------
let timerSecs = 25 * 60, timerLeft = timerSecs, timerId = null;
function fmt(s) { return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function drawTimer() { $('timer-display').textContent = fmt(timerLeft); }
document.querySelectorAll('[data-mins]').forEach((b) => b.addEventListener('click', () => { timerSecs = Number(b.dataset.mins) * 60; timerLeft = timerSecs; drawTimer(); }));
$('timer-start').addEventListener('click', () => {
  if (timerId) return;
  timerId = setInterval(() => { timerLeft--; drawTimer(); if (timerLeft <= 0) { clearInterval(timerId); timerId = null; addXP(20); toast('Focus session done +20 XP'); logTimer(); } }, 1000);
});
$('timer-pause').addEventListener('click', () => { clearInterval(timerId); timerId = null; });
$('timer-reset').addEventListener('click', () => { clearInterval(timerId); timerId = null; timerLeft = timerSecs; drawTimer(); });
function logTimer() { const l = store.get('sd_timers', []); l.unshift(new Date().toLocaleString() + ` (${timerSecs / 60}m)`); store.set('sd_timers', l.slice(0, 10)); renderTimerLog(); }
function renderTimerLog() { $('timer-log').innerHTML = store.get('sd_timers', []).map((t) => `<div>${esc(t)}</div>`).join(''); }

// ---------- modal ----------
function openModal(title, v1, v2, onSave) {
  $('modal-title').textContent = title;
  $('modal-field1').value = v1; $('modal-field2').value = v2;
  $('modal-field2').style.display = v2 !== '' || title.includes('note') ? '' : 'none';
  modalCtx = onSave; $('modal').classList.remove('hidden');
}
$('modal-cancel').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal-save').addEventListener('click', async () => {
  if (modalCtx) await modalCtx($('modal-field1').value, $('modal-field2').value);
  $('modal').classList.add('hidden');
});

// ---------- keyboard shortcuts ----------
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('modal').classList.add('hidden');
  if (e.code === 'Space' && !$('study-mode').classList.contains('hidden') && studyDeck.length) {
    const tag = (document.activeElement || {}).tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') { e.preventDefault(); studyFlipped = !studyFlipped; showStudy(); }
  }
});

// ---------- init ----------
if (store.get('sd_theme', 'light') === 'dark') { document.body.classList.add('dark'); $('theme-toggle').textContent = 'Light mode'; }
touchStreak(); drawTimer(); renderTimerLog(); refresh().catch(() => {});
