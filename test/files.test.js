const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractText, isSupported, SUPPORTED_EXTENSIONS, MAX_BYTES, MAX_TEXT } = require('../src/files');

// --- tiny ZIP writer, so the tests need no binary fixtures ------------------
// `fakeUncompressed` overrides the size declared in the headers (zip-bomb case).
function writeZip(entries, { fakeUncompressed = {} } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const body = entry.store ? raw : zlib.deflateRawSync(raw);
    const declared = fakeUncompressed[entry.name] ?? raw.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.store ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = (body, extra = []) => writeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: 'word/document.xml', data: `<w:document><w:body>${body}</w:body></w:document>` },
  ...extra,
]);
const slide = (text) => `<p:sld><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`;
const notes = (text) => `<p:notes><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:notes>`;

// --- plain text -------------------------------------------------------------
test('plain text, csv and markdown are read as UTF-8', () => {
  const out = extractText({ filename: 'baitap.txt', buffer: Buffer.from('Đề bài: tính đạo hàm.\nCâu 2: biến đổi.') });
  assert.equal(out.kind, 'text');
  assert.match(out.text, /Đề bài: tính đạo hàm\./);
  assert.equal(extractText({ filename: 'a.csv', buffer: Buffer.from('ten,diem\nAn,9') }).text, 'ten,diem\nAn,9');
  // The browser posts base64, so a plain string is decoded as base64 and anything outside the
  // base64 alphabet is refused instead of silently turning into mojibake.
  const base64 = Buffer.from('diem thi').toString('base64');
  assert.equal(extractText({ mimeType: 'text/plain', buffer: base64 }).text, 'diem thi');
  assert.throws(() => extractText({ filename: 'a.txt', buffer: 'diem thi!' }), { code: 'UNSUPPORTED' });
});

// --- docx -------------------------------------------------------------------
test('docx: paragraphs become newlines', () => {
  const body = para('Chuong 1 - Tong quan') + para('Chuong 2 - Bang bam');
  const out = extractText({ filename: 'giaotrinh.docx', buffer: docx(body) });
  assert.equal(out.kind, 'docx');
  assert.equal(out.text, 'Chuong 1 - Tong quan\nChuong 2 - Bang bam');
  assert.deepEqual(out.meta.entries, ['word/document.xml']);
  assert.equal(out.meta.truncated, false);
});

test('docx: XML entities are decoded', () => {
  const out = extractText({ filename: 'a.docx', buffer: docx(para('Tom &amp; Jerry &lt;3 &#272;&#x1EBF;n')) });
  assert.equal(out.text, 'Tom & Jerry <3 Đến');
});

test('docx: headers, footers and footnotes are included after the body', () => {
  const out = extractText({
    filename: 'a.docx',
    buffer: docx(para('Body text'), [
      { name: 'word/header1.xml', data: `<w:hdr>${para('Header note')}</w:hdr>` },
      { name: 'word/footnotes.xml', data: `<w:footnotes>${para('Footnote text')}</w:footnotes>` },
      { name: 'word/media/image1.png', data: 'not xml' },
    ]),
  });
  assert.deepEqual(out.meta.entries, ['word/document.xml', 'word/footnotes.xml', 'word/header1.xml']);
  assert.ok(out.text.startsWith('Body text'));
  assert.match(out.text, /Header note/);
  assert.match(out.text, /Footnote text/);
});

// --- pptx -------------------------------------------------------------------
test('pptx: slides are ordered by number, with speaker notes', () => {
  const out = extractText({
    filename: 'slide.pptx',
    buffer: writeZip([
      { name: 'ppt/slides/slide10.xml', data: slide('Cuoi cung') },
      { name: 'ppt/slides/slide2.xml', data: slide('Thu hai') },
      { name: 'ppt/notesSlides/notesSlide2.xml', data: notes('Ghi chu hai') },
      { name: 'ppt/slides/slide1.xml', data: slide('Dau tien') },
    ]),
  });
  assert.equal(out.kind, 'pptx');
  assert.equal(out.text, 'Dau tien\n\nThu hai\n\nGhi chu hai\n\nCuoi cung');
});

// --- xlsx -------------------------------------------------------------------
test('xlsx: shared strings, inline strings and numbers become rows of tabs', () => {
  const out = extractText({
    filename: 'diem.xlsx',
    buffer: writeZip([
      {
        name: 'xl/sharedStrings.xml',
        data: '<sst><si><t>Ten</t></si><si><r><t>Mid</t></r><r><t>term</t></r></si></sst>',
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: '<worksheet><sheetData>'
          + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
          + '<row r="2"><c r="A2"><v>42</v></c><c r="B2" t="inlineStr"><is><t>Done</t></is></c></row>'
          + '<row r="3"><c r="A3" t="s"><v>99</v></c></row>'
          + '</sheetData></worksheet>',
      },
    ]),
  });
  assert.equal(out.kind, 'xlsx');
  assert.equal(out.text, 'Ten\tMidterm\n42\tDone');
});

// --- error codes ------------------------------------------------------------
test('unsupported extension throws UNSUPPORTED', () => {
  assert.throws(() => extractText({ filename: 'old.doc', buffer: Buffer.from('x') }), { code: 'UNSUPPORTED' });
  assert.throws(() => extractText({ filename: 'archive.zip', buffer: Buffer.from('x') }), { code: 'UNSUPPORTED' });
});

test('empty content throws EMPTY', () => {
  assert.throws(() => extractText({ filename: 'a.txt', buffer: Buffer.from('   \n\n  ') }), { code: 'EMPTY' });
  assert.throws(() => extractText({ filename: 'a.txt' }), { code: 'EMPTY' });
});

test('oversized upload throws TOO_LARGE', () => {
  const big = Buffer.alloc(MAX_BYTES + 1, 0x61);
  assert.throws(() => extractText({ filename: 'a.txt', buffer: big }), { code: 'TOO_LARGE' });
});

test('long documents are truncated at MAX_TEXT', () => {
  const out = extractText({ filename: 'a.txt', buffer: Buffer.alloc(MAX_TEXT + 500, 0x61) });
  assert.equal(out.text.length, MAX_TEXT);
  assert.equal(out.meta.truncated, true);
});

// --- hostile archives -------------------------------------------------------
test('an entry escaping the archive root is refused', () => {
  const buf = writeZip([
    { name: '../evil.txt', data: 'pwned' },
    { name: 'word/document.xml', data: `<w:document>${para('ok')}</w:document>` },
  ]);
  assert.throws(() => extractText({ filename: 'a.docx', buffer: buf }), { code: 'BAD_ZIP' });
});

test('a zip bomb is refused before anything is inflated', () => {
  const buf = docx(para('small'));
  const bomb = writeZip(
    [
      { name: 'word/document.xml', data: `<w:document>${para('small')}</w:document>` },
      { name: 'word/footnotes.xml', data: 'x' },
    ],
    { fakeUncompressed: { 'word/footnotes.xml': 60 * 1024 * 1024 } },
  );
  assert.throws(() => extractText({ filename: 'a.docx', buffer: bomb }), { code: 'BAD_ZIP' });
  assert.throws(() => extractText({ filename: 'a.docx', buffer: buf.subarray(0, 10) }), { code: 'BAD_ZIP' });
});

// --- capability helpers -----------------------------------------------------
test('isSupported and SUPPORTED_EXTENSIONS describe what we accept', () => {
  for (const name of ['a.docx', 'a.pptx', 'a.xlsx', 'a.txt', 'a.md', 'a.csv', 'a.pdf', 'a.PNG']) {
    assert.equal(isSupported(name), true, name);
  }
  for (const name of ['a.doc', 'a.zip', 'a.exe', '']) assert.equal(isSupported(name), false, name);
  assert.equal(isSupported('text/plain'), true);
  assert.equal(isSupported('application/pdf'), true);
  assert.equal(isSupported('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), true);
  assert.equal(isSupported('application/zip'), false);
  assert.ok(SUPPORTED_EXTENSIONS.includes('.docx'));
});

test('PDF and images stay on the AI vision path instead of faking extraction', () => {
  const out = extractText({ filename: 'decuong.pdf', buffer: Buffer.from('%PDF-1.7 ...') });
  assert.equal(out.kind, 'binary');
  assert.equal(out.text, '');
  assert.deepEqual(out.meta.entries, []);
});
