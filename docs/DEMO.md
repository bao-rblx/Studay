# Live demo script (Session 20)

## Before the room fills up

1. Open the live URL (wakes Render) and `/api/health` (must say `"db":"up"`; if not,
   restore the Supabase project).
2. Sign in once so the free database has a warm connection, then sign out.
3. Keep a second browser (or a private window) open on the same URL for the sync moment.
4. Have a real `.docx` and a photo of a timetable on the desktop.

## Part 1 - the product (90 seconds)

1. **Accounts.** Create an account in the private window. Add a subject: the dialog that
   pops up has name, teacher, room, colour and weekly class times.
2. **Sync.** Refresh the first browser: the same account sees the same subject. Sign in as
   a second account: nothing of the first one is visible. Say the line: *"one account,
   every device - the old build shared one dataset between everyone."*
3. **Files.** Drop the `.docx` on the study buddy panel. Point at the read report
   ("read N characters from file.docx · local extractor") - no API key involved.
4. **Quiz.** Open the Quiz view, pick the subject, start. Answer one question wrong on
   purpose: the correct answer and the source sentence appear, then "practise the ones I
   missed" at the end.
5. **Search.** Type two letters of a subject name in the top bar; the grouped results find
   the subject, the note, the file and the deadline. Press Enter on one.
6. **Quick note.** Type "present databases next week" in the calendar bar: the AI proposes
   an event, nothing is saved until "Add to calendar" is pressed.

## Part 2 - the delivery pipeline

1. Show the gate: open the prepared PR from branch `demo/failing-test`, show the red `test`
   check and the disabled merge button.
2. Fix it, push, wait for green, get the review, merge.
3. Show the Actions run: `deploy` job triggers Render, then the change on the live URL.
4. Search the repo for secrets in front of the room: GitHub search for `AIza`,
   `postgres://`, `GEMINI_API_KEY=`; show the green `gitleaks` check.

## If the network dies

- `node scripts/dev-mem.js` runs the whole app on an in-memory database at
  http://127.0.0.1:3210 (accounts, files and quotes work; Gemini falls back to the offline
  helper). Everything except data persistence behaves exactly like production.
