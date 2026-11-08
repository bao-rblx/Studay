// Feature: teacher files (the files wave). Word, PowerPoint, Excel, PDF, text or a photo of
// the page: the server reads documents locally and sends images/PDFs to the AI, then the
// student confirms and the file is remembered for summaries and quizzes.
// The panel replaces whatever sits in #files-slot, so index.html stays markup-only.
window.Studay.register('files', {
  init() {
    mountPanel();
    wireDrop($('file-drop'), $('file-input'), readFile);
    if (!mounted) {
      mounted = true;
      // The buddy view chooses which subject a new file belongs to.
      $('buddy-subject').addEventListener('change', updateSaveLabel);
    }
    pending = null;
    $('file-output').innerHTML = '';
    updateSaveLabel();
  },
  render() { updateSaveLabel(); },
});

const ACCEPT = '.docx,.pptx,.xlsx,.pdf,.txt,.md,.markdown,.csv,.json,image/*';
// Extensions the server can read. Anything else is rejected before a byte is uploaded.
const READABLE = /\.(docx|pptx|xlsx|pdf|txt|md|markdown|csv|json|png|jpe?g|webp|heic)$/i;
const TYPE_LABELS = ['Word .docx', 'PowerPoint .pptx', 'Excel .xlsx', 'PDF', 'text .txt .md .csv .json', 'photos'];
const KIND_LABELS = { docx: 'Word document', pptx: 'PowerPoint deck', xlsx: 'Excel sheet', text: 'text file' };
const FILE_HINT = 'Word (.docx), PowerPoint (.pptx), Excel (.xlsx), PDF, image or text';

let mounted = false;
let pending = null; // the last successful read, waiting for the student to save it

function mountPanel() {
  const chips = TYPE_LABELS.map((t) => `<span class="file-chip">${esc(t)}</span>`).join('');
  $('files-slot').innerHTML = `
    <div class="panel drop" id="file-drop">
      <strong>📄 Drop a teacher file</strong>
      <p>Word, PowerPoint, Excel or PDF - or a photo of the page.
        I read it, summarise it and remember it for quizzes.</p>
      <input type="file" id="file-input" accept="${ACCEPT}" aria-label="Teacher file">
      <div class="file-types" id="file-types">${chips}</div>
      <p class="file-hint" id="file-subject-hint"></p>
    </div>
    <div id="file-output"></div>`;
}

const kindLabel = (res, name) => KIND_LABELS[res.kind]
  || (/\.pdf$/i.test(name) ? 'PDF' : 'image');

// Keep the save button honest about where the file is going.
function updateSaveLabel() {
  const sid = buddySubject();
  const hint = $('file-subject-hint');
  if (hint) {
    hint.textContent = sid
      ? `Saving to: ${subjectOf(sid)?.name || 'this subject'}`
      : 'Add a subject first - I need to know where to file this.';
  }
  const btn = $('file-save');
  if (!btn) return;
  btn.disabled = !sid || !pending;
  btn.textContent = sid ? `Save to ${subjectOf(sid)?.name || 'subject'}` : 'Add a subject first';
}

function showProblem(html) {
  mood('sad');
  $('file-output').innerHTML = `<div class="panel file-problem">${html}</div>`;
}

function unsupported(name) {
  const ext = (name.match(/\.[^.]+$/) || [''])[0];
  return `I can't read ${ext ? esc(ext) + ' files' : 'that file'} yet. Drop a ${FILE_HINT}.`;
}

async function readFile(file) {
  const name = file.name || 'file';
  if (!READABLE.test(name) && !file.type.startsWith('image/')) return showProblem(unsupported(name));
  if (file.size > UPLOAD_MAX) {
    return showProblem(`<strong>${esc(name)}</strong> is too large - I can read up to 10 MB.`);
  }

  pending = null;
  mood('thinking');
  $('file-output').innerHTML = `<div class="ai-loading">Reading ${esc(name)}...</div>`;
  let res;
  try {
    // FileReader is async and can fail, so the whole upload stays inside the try block.
    const data = await readAsBase64(file);
    res = await send('/api/ai/read-material', { file: { name, mime_type: file.type || '', data } });
  } catch (err) {
    // api() already toasted the reason; keep it on the panel as well.
    return showProblem(esc(err.message || 'I could not read that file.'));
  }
  if (!res || !res.content || !res.content.trim()) return showProblem('I could not find any text in that file.');
  pending = { res, name };
  mood('happy');
  renderResult();
}

function renderResult() {
  const { res, name } = pending;
  const chars = res.chars == null ? (res.content || '').length : res.chars;
  const warn = res.truncated
    ? `<p class="file-warn">That file is longer than I keep, so I read the first
        ${chars.toLocaleString()} characters.</p>`
    : '';
  $('file-output').innerHTML = `
    <div class="panel file-read">
      <h3>📄 ${esc(res.title || name)}</h3>
      <p class="file-meta">Read <strong>${chars.toLocaleString()}</strong> characters from <strong>${esc(name)}</strong>
        · ${esc(kindLabel(res, name))} · ${res.extractor === 'gemini' ? 'AI vision' : 'local extractor'}</p>
      ${warn}
      ${summaryHtml(res)}
      <details class="file-preview"><summary>Show what I read</summary><pre>${esc(preview(res.content))}</pre></details>
      <div class="row-actions"><button id="file-save">Save</button></div>
    </div>`;
  $('file-save').addEventListener('click', save);
  updateSaveLabel();
}

const preview = (content) => {
  const text = String(content || '');
  return text.length > 1200 ? `${text.slice(0, 1200)}\n...` : text;
};

async function save() {
  if (!pending) return;
  const sid = buddySubject();
  if (!sid) return toast('Add a subject first, then pick it above');
  const { res, name } = pending;
  try {
    await busy($('file-save'), 'Saving...', () => send('/api/materials', {
      subject_id: sid, title: res.title || name, filename: name, content: res.content, summary: res.summary,
    }));
  } catch {
    return; // api() already explained the failure
  }
  pending = null;
  addXP(15);
  mood('happy');
  toast('File remembered +15 XP');
  $('file-output').innerHTML = `<div class="panel file-saved">Saved <strong>${esc(name)}</strong> to
    <strong>${esc(subjectOf(sid)?.name || 'this subject')}</strong>. Ask me about it any time.</div>`;
  refresh();
}
