// Feature: teacher files. Drop a PDF, a slide screenshot or a text file and the study
// buddy reads it, summarises it and remembers it for quizzes.
// The files wave (docx/pptx/xlsx support) replaces the body of this file.
window.Studay.register('files', {
  init() {
    wireDrop($('mat-drop'), $('mat-file'), readTeacherFile);
  },
});

async function readTeacherFile(file) {
  const sid = buddySubject();
  if (!sid) return toast('Add a subject first, then pick it above');
  if (file.size > UPLOAD_MAX) return toast('File too large (max 10 MB)');
  mood('thinking');
  $('mat-output').innerHTML = '<div class="ai-loading">Reading your file...</div>';
  try {
    const body = isTextFile(file)
      ? { text: await file.text(), filename: file.name }
      : { file: { mime_type: file.type || 'application/pdf', data: await readAsBase64(file) }, filename: file.name };
    const out = await send('/api/ai/read-material', body);
    if (!out.content || !out.content.trim()) throw new Error('empty');
    await send('/api/materials', { subject_id: sid, title: out.title, filename: file.name, content: out.content, summary: out.summary });
    $('mat-output').innerHTML = `<div class="panel"><h3>📄 ${esc(out.title)}</h3>${summaryHtml(out)}</div>`;
    mood('happy'); addXP(15); toast('File remembered +15 XP'); refresh();
  } catch {
    mood('sad');
    $('mat-output').innerHTML = '<p class="hint">I could not read that file. PDFs and images need the AI key; plain .txt always works.</p>';
  }
}
