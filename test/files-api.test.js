// End-to-end checks for reading real Office files through the API: the extractor runs on the
// server, the result is saved as material, and one account never sees another's files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { setupWithUser } = require('./helpers');
const { docx, para, xlsx, writeZip } = require('./office-fixture');

const upload = (name, buffer, mime = '') => ({ file: { name, mime_type: mime, data: buffer.toString('base64') } });
const readMaterial = (agent, name, buffer, mime) => agent.post('/api/ai/read-material')
  .send(upload(name, buffer, mime));

const DOCX_TEXT = 'Chuong 1: Tong quan ve co so du lieu quan he. '
  + 'Bang du lieu gom cac hang va cac cot, khoa chinh xac dinh moi hang. '
  + 'Chuong 2: Phep chia va chuan hoa du lieu trong mo hinh quan he.';
const DOCX = docx(para('Chuong 1: Tong quan ve co so du lieu quan he.') + para('Chuong 2: Phep chia va chuan hoa.'));

test('a .docx is read locally, then saved as a material', async () => {
  const { agent } = await setupWithUser();
  const subject = (await agent.post('/api/subjects').send({ name: 'Databases' })).body;

  const read = await agent.post('/api/ai/read-material').send(upload('baitap.docx', DOCX));
  assert.equal(read.status, 200);
  assert.equal(read.body.extractor, 'local');
  assert.equal(read.body.kind, 'docx');
  assert.equal(read.body.truncated, false);
  assert.equal(read.body.filename, 'baitap.docx');
  assert.match(read.body.content, /Tong quan ve co so du lieu/);
  assert.ok(read.body.chars > 40);
  // The AI provider field is untouched, so the page can still say how the summary was made.
  assert.ok(['gemini', 'offline'].includes(read.body.source));

  const saved = await agent.post('/api/materials').send({
    subject_id: subject.id, title: read.body.title, filename: 'baitap.docx',
    content: read.body.content, summary: read.body.summary,
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.filename, 'baitap.docx');

  const list = await agent.get(`/api/materials?subject_id=${subject.id}`);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.match(list.body[0].content, /Phep chia va chuan hoa/);
});

test('a .xlsx loses its row structure nowhere: rows become lines of tab-joined cells', async () => {
  const { agent } = await setupWithUser();
  const book = xlsx({
    shared: ['Ten', 'Diem'],
    rows: [[{ shared: 0 }, { shared: 1 }], [{ inline: 'An' }, 9]],
  });
  const read = await agent.post('/api/ai/read-material').send(upload('diem.xlsx', book));
  assert.equal(read.status, 200);
  assert.equal(read.body.kind, 'xlsx');
  assert.match(read.body.content, /Ten\tDiem/);
});

test('a damaged document and an empty one are refused with 400', async () => {
  const { agent } = await setupWithUser();
  const notAZip = await readMaterial(agent, 'broken.docx', Buffer.from('not a zip at all'));
  assert.equal(notAZip.status, 400);
  assert.match(notAZip.body.error, /damaged/);

  const empty = await agent.post('/api/ai/read-material').send(upload('empty.txt', Buffer.from('   \n ')));
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /no readable text/);

  // A short file is not an error - it just has no summary yet.
  const tiny = await agent.post('/api/ai/read-material').send(upload('a.txt', Buffer.from('hello')));
  assert.equal(tiny.status, 200);
  assert.equal(tiny.body.chars, 5);
});

test('an unsupported type is refused and says which types work', async () => {
  const { agent } = await setupWithUser();
  const res = await agent.post('/api/ai/read-material').send(upload('archive.zip', Buffer.from('PK')));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /\.docx/);
  assert.match(res.body.error, /\.xlsx/);

  const legacy = await agent.post('/api/ai/read-material').send(upload('old.doc', Buffer.from('x')));
  assert.equal(legacy.status, 400);
});

test('a long document is truncated to MAX_TEXT and says so', async () => {
  const { agent } = await setupWithUser();
  const long = docx(para('a'.repeat(210000)));
  const read = await agent.post('/api/ai/read-material').send(upload('long.docx', long));
  assert.equal(read.status, 200);
  assert.equal(read.body.truncated, true);
  assert.equal(read.body.chars, 200000);
  assert.equal(read.body.content.length <= 200000, true);
});

test('images and PDFs still go to the AI vision path', async () => {
  const { agent } = await setupWithUser();
  const image = await readMaterial(agent, 'photo.png', Buffer.from('fake image'), 'image/png');
  assert.equal(image.status, 200);
  assert.equal(image.body.extractor, 'gemini');
  assert.equal(image.body.kind, 'binary');
  assert.equal(image.body.chars, null);

  const pdf = await readMaterial(agent, 'decuong.pdf', Buffer.from('%PDF-1.7'), 'application/pdf');
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.extractor, 'gemini');

  // A bad base64 body is still a 400, exactly as before this change.
  const bad = await agent.post('/api/ai/read-material').send({ file: { mime_type: 'image/png', data: '<script>' } });
  assert.equal(bad.status, 400);
});

test('pasted text keeps working and is marked as local', async () => {
  const { agent } = await setupWithUser();
  const res = await agent.post('/api/ai/read-material').send({ text: DOCX_TEXT, filename: 'week1.txt' });
  assert.equal(res.status, 200);
  assert.equal(res.body.extractor, 'local');
  assert.equal(res.body.kind, 'text');
  assert.ok(res.body.summary);
  assert.equal((await agent.post('/api/ai/read-material').send({ text: 'hi' })).status, 400);
});

test('one account never sees another account\'s uploaded material', async () => {
  const { agent } = await setupWithUser({ email: 'owner@example.com' });
  const subject = (await agent.post('/api/subjects').send({ name: 'Networks' })).body;
  const read = await agent.post('/api/ai/read-material').send(upload('net.docx', DOCX));
  const saved = await agent.post('/api/materials').send({
    subject_id: subject.id, title: read.body.title, content: read.body.content, summary: read.body.summary,
  });
  assert.equal(saved.status, 201);
  assert.equal((await agent.get('/api/materials')).body.length, 1);

  const { app } = await setupWithUser({ email: 'other@example.com' });
  const intruder = request.agent(app);
  await intruder.post('/api/auth/login').send({ email: 'other@example.com', password: 'password123' });
  assert.deepEqual((await intruder.get('/api/materials')).body, []);
  // And the other account cannot delete it either.
  assert.equal((await intruder.delete(`/api/materials/${saved.body.id}`)).status, 404);
});

test('a zip that inflates past the cap is refused before it is read', async () => {
  const { agent } = await setupWithUser();
  const bomb = writeZip(
    [
      { name: 'word/document.xml', data: `<w:document>${para('small')}</w:document>` },
      { name: 'word/footnotes.xml', data: 'x' },
    ],
    { fakeUncompressed: { 'word/footnotes.xml': 60 * 1024 * 1024 } },
  );
  const res = await agent.post('/api/ai/read-material').send(upload('bomb.docx', bomb));
  assert.equal(res.status, 400);
  assert.match(res.body.error, /damaged/);
});
