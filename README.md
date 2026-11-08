# Studay - AI-Powered Study Companion

Final project for 72ITDS30103 Software Development Platforms.

Each student signs in to their own account and organises their term: subjects with weekly
class times, notes, the teacher's files, deadlines, and a quiz built from their own
material. Google Gemini reads the parts that need understanding (a timetable photo, a
summary, the study buddy chat); everything that can be done locally stays local, so the
app still works with no API key.

- Live: https://studay-vkjl.onrender.com  <!-- replace with your Render URL -->
- CI: GitHub Actions (lint, test, Docker build, deploy on merge, secret scan)

## What it does

| Area | What a student gets |
|---|---|
| Accounts | Sign up / sign in with email + password. The same account on a laptop and a phone shows the same data; two accounts never see each other's rows. |
| Calendar | Month grid with classes and deadlines, "coming up" list, quick-note box: type "math exam 15/11 8:00" and the AI proposes the event before it is saved. |
| Subjects | Colours, teacher, room, weekly class times, added through a dialog or by scanning a timetable photo. |
| Notes | Free text per subject, with a one-click AI summary. |
| Teacher files | Drop a `.docx`, `.pptx`, `.xlsx`, `.pdf`, image, `.txt`, `.md`, `.csv` or `.json`; Studay extracts the text, summarises it and remembers it for quizzes. |
| Quiz | Questions generated from the material you actually uploaded - one at a time, instant feedback, "retry the ones I missed", best score per subject. Needs no API key. |
| Search | One box in the top bar finds subjects, notes, files and deadlines by name. |
| Study buddy | Chat about one subject, grounded in that subject's notes and files. |
| Focus timer | 15/25/50 minute sessions with XP. |

## Architecture

```
Browser --HTTPS--> Render (Docker: Node 22 + Express) --TLS:5432--> Supabase PostgreSQL
       |                        |
       | session cookie         +--HTTPS--> Google Gemini API   (key stays on the server)
       | (HttpOnly, SameSite)   +-- local --> src/files.js       (docx/pptx/xlsx text, no key)
       |                        +-- local --> src/quiz.js        (quiz questions, no key)
GitHub PR --> Actions: lint, test, build --merge to main--> deploy hook --> Render
```

- `src/app.js` is a composition root: middleware, then one router per feature from
  `src/routes/`, mounted behind the auth middleware.
- `src/auth.js` owns password hashing (scrypt) and sessions (a random token in an
  HttpOnly cookie; only its SHA-256 is stored, so a database dump cannot be replayed).
- `src/files.js` and `src/quiz.js` are dependency-free engines, which is why the file and
  quiz features work with no Gemini key at all.
- `public/app.js` is the frontend core; each feature owns one `public/feature-*.js` file and
  registers itself on `window.Studay`, so features can be developed and reviewed one wave
  at a time without touching each other.

## Run locally (one command)

Requires Docker Desktop.

```bash
git clone https://github.com/bao-rblx/Studay.git
cd Studay
docker compose up --build
```

Open http://localhost:3000, create an account, and start adding subjects. Without a Gemini
key the AI features fall back to the offline helper and the file/quiz engines still work.
To use Gemini locally:

```bash
GEMINI_API_KEY=your-key docker compose up --build
```

## Development without Docker

```bash
cp .env.example .env      # point DATABASE_URL at a Postgres you run yourself
npm ci
npm run lint
npm test                  # in-memory Postgres, no database needed
npm start
```

If you have neither Postgres nor Docker, the whole app also runs on an in-memory database:

```bash
node scripts/dev-mem.js   # http://127.0.0.1:3210
```

Data disappears when that process stops; it is only for clicking through the UI.

## Accounts and data

- Passwords: scrypt with a per-user salt, stored as `scrypt$<salt>$<hash>`. Changing a
  password requires the current one.
- Sessions: a 32-byte random token in an `HttpOnly; SameSite=Lax` cookie (adds `Secure` in
  production), valid for 30 days, one row per device in `sessions`. Signing out deletes the
  row, so a copied cookie stops working.
- Tenancy: `subjects`, `notes`, `events` and `materials` carry `user_id` and every query
  filters on it. A request for someone else's record answers 404, not 403, so ids cannot be
  probed.
- Legacy data: the first account ever created on a database claims rows that predate
  accounts (`user_id IS NULL`), so upgrading a one-device install loses nothing.

## Supported files

| Type | How the text is obtained | Needs Gemini? |
|---|---|---|
| `.docx` | local ZIP + XML extraction (body, tables, headers, footnotes) | No |
| `.pptx` | local ZIP + XML extraction (slides in order + speaker notes) | No |
| `.xlsx` | local ZIP + XML extraction (shared strings, one line per row) | No |
| `.txt` `.md` `.csv` `.json` | read as UTF-8 | No |
| `.pdf`, `.png`, `.jpg`, `.webp`, `.heic` | sent to Gemini vision | Yes (falls back to a notice) |

Limits: 10 MB per upload in the UI (20 MB in the extractor as a backstop), 200k characters
of extracted text per file. Archives are read through an allow-list of entry names with an
inflation budget, so zip-slip and zip-bomb files are rejected as damaged.

## Quiz

`POST /api/quiz` builds a quiz from a subject's notes and files with a seeded local engine
(no key, no network): multiple choice, fill in the blank, and self-check cards when the
material is thin. Grading happens on the server (`POST /api/quiz/check`) so the tolerance
rules live in one place. Gemini is only asked to top up when the local engine cannot make
enough questions *and* a key is configured. Scores and "practise the ones I missed" live in
the browser, per account.

## Configuration

| Variable | Local (Compose) | Production (Render) | Secret |
|---|---|---|---|
| `DATABASE_URL` | set in `compose.yaml` | Render dashboard (Supabase session pooler URL) | Yes |
| `DB_SSL` | `false` | `true` | No |
| `GEMINI_API_KEY` | shell variable, optional | Render dashboard | Yes |
| `GEMINI_MODEL` | default `gemini-2.5-flash` | `render.yaml` | No |
| `RENDER_DEPLOY_HOOK` | - | GitHub Actions secret | Yes |

No signing secret is needed: session tokens are random and stored hashed, so there is
nothing to sign.

## Failure behaviour

| Failure | What the user sees |
|---|---|
| Gemini returns 429 / times out / bad output | Offline summary, quiz and file reading still work; a notice explains why |
| Database paused or restarting | Orange banner "database is waking up", automatic retry every 10 s |
| Server unreachable | Banner "Cannot reach the server" |
| Session expired or cookie cleared | Sign-in card, then straight back to where they were |
| Document damaged / unsupported | The panel names the types that work (or asks to save the file again) |

## API

Everything except `/api/health` and `/api/auth/*` needs a session cookie and is scoped to
that account.

- `GET /api/health` - 200 when the database answers, 503 otherwise
- `POST /api/auth/register|login|logout`, `GET|PUT|DELETE /api/auth/me`
- `GET|POST /api/subjects`, `POST /api/subjects/bulk`, `PUT|DELETE /api/subjects/:id`
- `GET|POST /api/notes` (`?subject_id=`), `PUT|DELETE /api/notes/:id`
- `GET|POST /api/events` (`?from=&to=`), `PUT|DELETE /api/events/:id`
- `GET|POST /api/materials` (`?subject_id=`), `DELETE /api/materials/:id`
- `POST /api/quiz` `{ subject_id | material_id, count, seed }`, `POST /api/quiz/check`
- `GET /api/search?q=` - subjects, notes, files and events by name
- `POST /api/ai/generate` `{ note_id | content, mode }`, `/api/ai/scan-timetable`,
  `/api/ai/quick-note`, `/api/ai/read-material`, `/api/ai/ask`

## Tests

`npm test` runs the suite against an in-memory PostgreSQL (pg-mem), so CI needs no database
and no API key:

- `test/api.test.js` - the REST surface: validation, cascades, 503 when the database is down
- `test/auth.test.js` - register/login/logout, session expiry, two accounts isolated, the
  legacy-data claim, password changes, hashed storage
- `test/files.test.js` - docx/pptx/xlsx/text extraction, damaged archives, zip bombs
- `test/files-api.test.js`, `test/files-ui.test.js` - uploads through the API and the panel
  behaviour in a small DOM stub
- `test/quiz.test.js`, `test/quiz-api.test.js` - the question engine and the endpoints
- `test/search.test.js`, `test/search-api.test.js` - the SQL builder and the endpoint
- `test/ui.test.js` - the page and its scripts agree: every file exists, every element id a
  script looks up is defined, no duplicate ids, every feature registers itself
- `test/flow.test.js` - one student's whole session: account, subject, note, Word file,
  quiz, deadline, search, delete

`npm run lint` is ESLint 9 (flat config) over the server, the browser scripts and the tests.

## Team

| Member | Area |
|---|---|
| Luu Gia Bao (@bao-rblx) | Backend, PostgreSQL, database resilience, secret scanning |
| Tran Quang Minh | AI integration (Gemini), tests, CI/CD pipeline |
| Nguyen Trung Duc (@Kaizawa388222) | Frontend, Docker, Compose, Render deployment |
