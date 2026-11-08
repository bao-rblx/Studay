// Behaviour checks for the files feature without a browser: the script is run inside a tiny
// DOM stand-in and the panel it builds is inspected. This covers the wiring that ui.test.js
// can only check by name (ids exist) — the drop handler actually reading, warning and saving.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'feature-files.js'), 'utf8');

// Minimal DOM: an element is an inert record with innerHTML/textContent/disabled. Assigning
// innerHTML registers the ids inside it, exactly like getElementById does after a render.
function fakeDom() {
  const elements = new Map();
  const ensure = (id) => elements.get(id) || elements.set(id, makeElement(id)).get(id);
  function makeElement(id) {
    const node = { id, _html: '', textContent: '', disabled: false, listeners: {} };
    Object.defineProperty(node, 'innerHTML', {
      get: () => node._html,
      set(html) {
        node._html = String(html);
        for (const m of node._html.matchAll(/id="([^"]+)"/g)) ensure(m[1]);
      },
    });
    node.addEventListener = (type, fn) => { node.listeners[type] = fn; };
    return node;
  }
  return { elements, ensure, $: (id) => elements.get(id) || null };
}

// Load feature-files.js against scripted globals and return its feature plus a call log.
function loadFeature({ readResult = {}, subject = 1, sendError = null } = {}) {
  const dom = fakeDom();
  ['files-slot', 'file-output', 'buddy-subject'].forEach(dom.ensure);
  const calls = { send: [], toast: [], moods: [], xp: 0, refresh: 0, wireDrop: null };
  let feature = null;

  const sandbox = {
    window: { Studay: { register: (name, f) => { feature = { name, ...f }; } } },
    document: { getElementById: dom.$ },
    $: dom.$,
    // The helpers this feature borrows from app.js.
    esc: (s) => String(s ?? '').replace(/[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    UPLOAD_MAX: 10 * 1024 * 1024,
    buddySubject: () => subject,
    subjectOf: (id) => (id ? { id, name: 'Databases' } : undefined),
    toast: (msg) => calls.toast.push(msg),
    mood: (m) => calls.moods.push(m),
    addXP: (n) => { calls.xp += n; },
    refresh: () => { calls.refresh += 1; },
    busy: (btn, label, fn) => fn(),
    send: async (url, body) => {
      calls.send.push({ url, body });
      if (sendError) throw new Error(sendError);
      return readResult;
    },
    readAsBase64: async () => 'QUJD',
    summaryHtml: (out) => `<div class="ai-block">${out.summary ? out.summary.summary : 'no summary'}</div>`,
    wireDrop: (panel, input, handler) => { calls.wireDrop = handler; },
  };
  vm.runInNewContext(SOURCE, sandbox, { filename: 'feature-files.js' });
  return { feature, dom, calls };
}

const file = (name, size = 2048, type = '') => ({ name, size, type });

test('init() builds the drop panel with every readable type and the save target', () => {
  const { feature, dom } = loadFeature();
  feature.init();
  const html = dom.$('files-slot').innerHTML;
  assert.match(html, /id="file-drop"/);
  assert.match(html, /id="file-input"/);
  assert.match(html, /accept="[^"]*\.docx[^"]*"/);
  assert.match(html, /accept="[^"]*\.pptx[^"]*"/);
  assert.match(html, /accept="[^"]*\.xlsx[^"]*"/);
  assert.match(html, /accept="[^"]*\.pdf[^"]*"/);
  assert.match(html, /accept="[^"]*\.csv[^"]*"/);
  assert.match(html, /Word \.docx/);
  assert.match(dom.$('file-subject-hint').textContent, /Saving to: Databases/);
});

test('without a subject the page asks for one instead of uploading', () => {
  const { feature, dom, calls } = loadFeature({ subject: null });
  feature.init();
  assert.match(dom.$('file-subject-hint').textContent, /Add a subject first/);
  assert.equal(calls.send.length, 0);
});

test('an unsupported type is explained before anything is uploaded', async () => {
  const { feature, dom, calls } = loadFeature();
  feature.init();
  await calls.wireDrop(file('recording.mp4', 500, 'video/mp4'));
  assert.equal(calls.send.length, 0, 'nothing should be uploaded');
  assert.match(dom.$('file-output').innerHTML, /can't read \.mp4 files/);
  assert.match(dom.$('file-output').innerHTML, /\.docx/);
});

test('a docx is uploaded, and the panel reports what was read', async () => {
  const { feature, dom, calls } = loadFeature({
    readResult: {
      title: 'Giao trinh', content: 'Chuong 1 ...', summary: { summary: 'Tom tat', key_points: [] },
      extractor: 'local', kind: 'docx', chars: 11993, truncated: false, filename: 'giao-trinh.docx',
    },
  });
  feature.init();
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await calls.wireDrop(file('giao-trinh.docx', 4096, DOCX_MIME));

  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].url, '/api/ai/read-material');
  assert.equal(calls.send[0].body.file.name, 'giao-trinh.docx');
  assert.equal(calls.send[0].body.file.data, 'QUJD');

  const html = dom.$('file-output').innerHTML;
  assert.match(html, /11,993<\/strong> characters from/);
  assert.match(html, /local extractor/);
  assert.match(html, /Word document/);
  assert.match(html, /id="file-save"/);
  assert.equal(dom.$('file-save').disabled, false);
  assert.equal(dom.$('file-save').textContent, 'Save to Databases');
});

test('a truncated file says how much of it was kept, and AI-read files say so', async () => {
  const truncated = loadFeature({
    readResult: {
      content: 'x', extractor: 'local', kind: 'docx', chars: 200000, truncated: true, filename: 'big.docx',
    },
  });
  truncated.feature.init();
  await truncated.calls.wireDrop(file('big.docx'));
  assert.match(truncated.dom.$('file-output').innerHTML, /read the first\s+200,000 characters/);

  const vision = loadFeature({
    readResult: {
      content: 'text from a scan', extractor: 'gemini', kind: 'binary', chars: null,
      truncated: false, filename: 'scan.pdf',
    },
  });
  vision.feature.init();
  await vision.calls.wireDrop(file('scan.pdf', 2048, 'application/pdf'));
  assert.match(vision.dom.$('file-output').innerHTML, /AI vision/);
  assert.match(vision.dom.$('file-output').innerHTML, /PDF/);
});

test('saving posts the material to the chosen subject and refreshes the page', async () => {
  const { feature, dom, calls } = loadFeature({
    readResult: {
      title: 'Giao trinh', content: 'Chuong 1 ...', summary: { summary: 'Tom tat' },
      extractor: 'local', kind: 'docx', chars: 120, truncated: false, filename: 'giao-trinh.docx',
    },
  });
  feature.init();
  await calls.wireDrop(file('giao-trinh.docx'));
  await dom.$('file-save').listeners.click();

  const saved = calls.send.find((c) => c.url === '/api/materials');
  assert.ok(saved, 'the material must be posted');
  assert.equal(saved.body.subject_id, 1);
  assert.equal(saved.body.filename, 'giao-trinh.docx');
  assert.equal(saved.body.title, 'Giao trinh');
  assert.match(dom.$('file-output').innerHTML, /Saved <strong>giao-trinh\.docx<\/strong>/);
  assert.equal(calls.xp, 15);
  assert.equal(calls.refresh, 1);
  assert.ok(calls.toast.some((t) => /remembered/.test(t)));
});

test('too large, unreadable and failed uploads all land on the panel', async () => {
  const big = loadFeature();
  big.feature.init();
  await big.calls.wireDrop(file('huge.docx', 11 * 1024 * 1024));
  assert.equal(big.calls.send.length, 0);
  assert.match(big.dom.$('file-output').innerHTML, /too large/);

  const failed = loadFeature({ sendError: 'that document looks damaged - save it again from Word' });
  failed.feature.init();
  await failed.calls.wireDrop(file('broken.docx'));
  assert.match(failed.dom.$('file-output').innerHTML, /damaged/);
  assert.equal(failed.dom.$('file-save'), null, 'nothing to save after a failed read');
  assert.ok(failed.calls.moods.includes('sad'));
});
