// Feature: global search in the top bar, plus the add/edit-subject dialog.
// Both close gaps the core page left: there was no way to find a subject, note, file or
// deadline by name, and a subject could only be added through a cramped inline form that
// had no room for the teacher, the room or the weekly timetable.
const GS_MIN = 2;            // same minimum the /api/search endpoint enforces
const GS_DEBOUNCE = 250;
const GS_ORDER = ['subject', 'note', 'material', 'event'];
const GS_ICON = { subject: '📚', note: '📝', material: '📄', event: '📅' };
const GS_LABEL = { subject: 'Subjects', note: 'Notes', material: 'Files', event: 'Calendar' };
const SE_MAX_ROWS = 14;      // the API keeps at most 14 weekly class entries

window.Studay.register('search', {
  init() {
    mountSearch();
    mountSubjectActions();
    // Subject tiles call the global editSubject(); send those clicks to the same dialog.
    window.editSubject = (id) => {
      const subject = subjectOf(id);
      if (subject) openSubjectEditor(subject);
    };
  },
  // Results are fetched on demand, so a refresh has nothing to redraw here.
  render() {},
});

// ---------- top-bar search ----------
let gsTimer = null;
let gsSeq = 0;               // answers arrive out of order; only the newest one is painted

function mountSearch() {
  const slot = $('global-search-slot');
  if (!slot || slot.dataset.mounted) return;   // init() runs again after every sign-in
  slot.dataset.mounted = '1';
  slot.innerHTML = `<div class="gs">
    <span class="gs-ico" aria-hidden="true">🔍</span>
    <input id="gs-input" type="search" autocomplete="off" spellcheck="false" role="combobox"
      aria-expanded="false" aria-autocomplete="list" aria-controls="gs-results"
      aria-label="Search subjects, notes, files and deadlines"
      placeholder="Search subjects, notes, files, deadlines...">
    <button id="gs-clear" class="gs-clear hidden" type="button" aria-label="Clear search">✕</button>
    <div id="gs-results" class="gs-results hidden" role="listbox" aria-label="Search results"></div>
  </div>`;

  $('gs-input').addEventListener('input', onQueryInput);
  $('gs-input').addEventListener('keydown', onQueryKey);
  $('gs-input').addEventListener('focus', () => { if ($('gs-input').value.trim().length >= GS_MIN) runSearch(); });
  $('gs-clear').addEventListener('click', () => {
    $('gs-input').value = '';
    $('gs-clear').classList.add('hidden');
    gsHide();
    $('gs-input').focus();
  });
  // mousedown, not click: the input blurs first and would close the list before the click.
  $('gs-results').addEventListener('mousedown', (e) => {
    const item = e.target.closest('.gs-item');
    if (!item) return;
    e.preventDefault();
    openHit(item.dataset.type, Number(item.dataset.id));
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#global-search-slot')) gsHide(); });
}

function onQueryInput() {
  const raw = $('gs-input').value;
  $('gs-clear').classList.toggle('hidden', !raw);
  clearTimeout(gsTimer);
  if (raw.trim().length < GS_MIN) {
    gsSeq++;                 // drop a request that is still in flight
    gsHide();
    return;
  }
  gsTimer = setTimeout(runSearch, GS_DEBOUNCE);
}

async function runSearch() {
  const term = $('gs-input').value.trim();
  if (term.length < GS_MIN) return gsHide();
  const seq = ++gsSeq;
  let out;
  try {
    out = await api(`/api/search?q=${encodeURIComponent(term)}`);
  } catch {
    return gsHide();         // api() already told the user what went wrong
  }
  if (seq !== gsSeq) return; // a later keystroke has taken over
  gsPaint(out.query, out.results || []);
}

function gsPaint(query, results) {
  const box = $('gs-results');
  if (!query) return gsHide();
  box.innerHTML = results.length
    ? GS_ORDER.map((type) => gsGroupHtml(type, results.filter((r) => r.type === type))).join('')
    : `<p class="gs-empty">No matches for “${esc(query)}”</p>`;
  box.classList.remove('hidden');
  $('gs-input').setAttribute('aria-expanded', 'true');
}

function gsGroupHtml(type, rows) {
  if (!rows.length) return '';
  return `<div class="gs-group">
    <div class="gs-group-head"><span aria-hidden="true">${GS_ICON[type]}</span>${GS_LABEL[type]}
      <span class="gs-count">${rows.length}</span></div>
    ${rows.map(gsItemHtml).join('')}
  </div>`;
}

function gsItemHtml(row) {
  const icon = row.type === 'event' ? (KIND_ICON[row.subtitle] || GS_ICON.event) : GS_ICON[row.type];
  return `<button type="button" class="gs-item" role="option" aria-selected="false"
      data-type="${esc(row.type)}" data-id="${esc(row.id)}">
    <span class="gs-item-ico" aria-hidden="true">${icon}</span>
    <span class="gs-item-text"><strong>${esc(row.title)}</strong><small>${esc(gsMeta(row))}</small></span>
  </button>`;
}

// One short context line under the name: where the record lives.
function gsMeta(row) {
  if (row.type === 'event') return [row.event_date, row.subject_name].filter(Boolean).join(' · ');
  if (row.type === 'subject') return row.subtitle || 'Subject';
  return row.subject_name || '';
}

function gsItems() {
  return [...$('gs-results').querySelectorAll('.gs-item')];
}

function gsActivate(index) {
  const items = gsItems();
  items.forEach((item, i) => {
    const on = i === index;
    item.classList.toggle('active', on);
    item.setAttribute('aria-selected', String(on));
  });
  if (items[index]) items[index].scrollIntoView({ block: 'nearest' });
}

function onQueryKey(e) {
  const items = gsItems();
  if (e.key === 'Escape') {
    gsHide();
    $('gs-input').blur();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    const current = items.findIndex((item) => item.classList.contains('active'));
    const next = current === -1
      ? (step === 1 ? 0 : items.length - 1)
      : (current + step + items.length) % items.length;
    gsActivate(next);
    return;
  }
  if (e.key === 'Enter') {
    // Enter with nothing highlighted opens the first hit, which is the best match.
    const target = items.find((item) => item.classList.contains('active')) || items[0];
    if (!target) return;
    e.preventDefault();
    openHit(target.dataset.type, Number(target.dataset.id));
  }
}

function gsHide() {
  const box = $('gs-results');
  if (!box) return;
  box.classList.add('hidden');
  $('gs-input').setAttribute('aria-expanded', 'false');
}

// Every hit opens the real record, not a read-only preview.
async function openHit(type, id) {
  gsHide();
  $('gs-input').value = '';
  $('gs-clear').classList.add('hidden');
  if (type === 'subject') {
    go('subjects');
    let subject = subjectOf(id);
    if (!subject) {           // the cached list can be stale after a change on another device
      await refresh();
      subject = subjectOf(id);
    }
    if (subject) openSubjectEditor(subject);
    else toast('That subject is no longer here');
    return;
  }
  if (type === 'note') {
    go('notes');
    window.editNote(id);
    return;
  }
  if (type === 'event') {
    go('calendar');
    window.openEvent(id);
    return;
  }
  go('buddy');
  revealMaterial(id);
}

// Materials have no editor of their own, so show the file where it lives, expanded.
function revealMaterial(id) {
  const material = state.materials.find((m) => m.id === id);
  if (!material) return toast('That file is no longer here');
  $('buddy-subject').value = String(material.subject_id);
  window.renderMaterials();
  const shown = state.materials.filter((m) => m.subject_id === material.subject_id);
  const card = document.querySelectorAll('#mat-list details.mat')[shown.findIndex((m) => m.id === id)];
  if (!card) return;
  card.open = true;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- subject actions ----------
function mountSubjectActions() {
  const slot = $('subject-actions-slot');
  if (!slot || slot.dataset.mounted) return;
  slot.dataset.mounted = '1';
  slot.innerHTML = `<div class="subject-actions">
    <button id="new-subject-btn" type="button">+ New subject</button>
    <small class="hint">Add the course once: teacher, room, colour and every weekly class.</small>
  </div>`;
  $('new-subject-btn').addEventListener('click', () => openSubjectEditor());
}

// ---------- add / edit subject dialog ----------
function seRow(entry = {}) {
  const dayOptions = DAY_SHORT.map((label, i) =>
    `<option value="${i}" ${i === (entry.day ?? 1) ? 'selected' : ''}>${label}</option>`).join('');
  return `<div class="se-row">
    <select class="se-day" aria-label="Day of the week">${dayOptions}</select>
    <input type="time" class="se-start" value="${esc(entry.start || '')}" aria-label="Starts at">
    <input type="time" class="se-end" value="${esc(entry.end || '')}" aria-label="Ends at">
    <input class="se-room" value="${esc(entry.room || '')}" placeholder="Room" aria-label="Room for this class">
    <button type="button" class="ghost se-remove" aria-label="Remove this class time">✕</button>
  </div>`;
}

function subjectEditorHtml(subject, editing) {
  return `<div id="subject-editor" class="subject-editor">
    <label>Subject name<input id="se-name" value="${esc(subject.name || '')}"
      placeholder="e.g. Databases" required></label>
    <div class="row2">
      <label>Teacher<input id="se-teacher" value="${esc(subject.teacher || '')}"
        placeholder="e.g. Dr. Lan"></label>
      <label>Room<input id="se-room" value="${esc(subject.room || '')}" placeholder="e.g. B2-14"></label>
    </div>
    <label class="se-color">Colour<input type="color" id="se-color"
      value="${esc(subject.color || PALETTE[0])}"></label>
    <div class="se-sched-head">Weekly classes <span class="hint">optional</span></div>
    <div id="se-schedule">${(subject.schedule || []).map(seRow).join('')}</div>
    <button type="button" class="ghost" id="se-add-time">+ add time</button>
    ${editing ? '<button type="button" class="danger" id="se-delete">Delete this subject</button>' : ''}
  </div>`;
}

function readSubjectEditor() {
  const name = $('se-name').value.trim();
  if (!name) {
    toast('Give the subject a name');
    return null;
  }
  const schedule = [...document.querySelectorAll('#se-schedule .se-row')]
    .map((row) => ({
      day: Number(row.querySelector('.se-day').value),
      start: row.querySelector('.se-start').value || null,
      end: row.querySelector('.se-end').value || null,
      room: row.querySelector('.se-room').value.trim() || null,
    }))
    // A row the user added but never filled in would only store noise.
    .filter((entry) => entry.start || entry.end || entry.room);
  return {
    name,
    teacher: $('se-teacher').value.trim() || null,
    room: $('se-room').value.trim() || null,
    color: $('se-color').value,
    schedule,
  };
}

// `subject` is a row from state.subjects, or nothing for a brand-new course.
function openSubjectEditor(subject) {
  const editing = Boolean(subject && subject.id);
  const draft = subject || { name: '', teacher: '', room: '', schedule: [] };
  openModal(editing ? 'Edit subject' : 'New subject', subjectEditorHtml(draft, editing), async () => {
    const body = readSubjectEditor();
    if (!body) return false;                    // keep the dialog open
    if (editing) {
      await send(`/api/subjects/${subject.id}`, body, 'PUT');
      toast('Subject updated');
    } else {
      await send('/api/subjects', body);
      addXP(5);
      toast('Subject added +5 XP');
    }
    await refresh();
    return true;
  }, editing ? 'Save changes' : 'Add subject');

  // The dialog body is rebuilt on every open, so these listeners never pile up.
  $('se-add-time').addEventListener('click', () => {
    if (document.querySelectorAll('#se-schedule .se-row').length >= SE_MAX_ROWS) {
      return toast(`A subject can have at most ${SE_MAX_ROWS} class times`);
    }
    $('se-schedule').insertAdjacentHTML('beforeend', seRow());
  });
  $('se-schedule').addEventListener('click', (e) => {
    const remove = e.target.closest('.se-remove');
    if (remove) remove.closest('.se-row').remove();
  });
  if (editing) $('se-delete').addEventListener('click', () => deleteFromEditor(subject));
}

async function deleteFromEditor(subject) {
  if (!confirm(`Delete ${subject.name} with its notes, files and events?`)) return;
  await api(`/api/subjects/${subject.id}`, { method: 'DELETE' });
  closeModal();
  toast('Subject deleted');
  await refresh();
}
