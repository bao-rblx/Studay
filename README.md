# Studay - AI-Powered Study Companion

Final project for 72ITDS30103 Software Development Platforms.
Students organise subjects, notes and flashcards (full CRUD) and generate a
summary, flashcards and a quiz from a note with Google Gemini.

- Live: https://studay-vkjl.onrender.com  <!-- replace with your Render URL -->
- CI: GitHub Actions (lint, test, Docker build, deploy on merge, secret scan)

## Architecture

```
Browser --HTTPS--> Render (Docker: Node 22 + Express) --TLS:5432--> Supabase PostgreSQL
                         |
                         +--HTTPS--> Google Gemini API   (key stays on the server)
GitHub PR --> Actions: lint, test, build --merge to main--> deploy hook --> Render
```

## Run locally (one command)

Requires Docker Desktop.

```bash
git clone https://github.com/bao-rblx/Studay.git
cd Studay
docker compose up --build
```

Open http://localhost:3000. Without a Gemini key the AI feature uses the
offline generator. To use Gemini locally:

```bash
GEMINI_API_KEY=your-key docker compose up --build
```

## Development without Docker

```bash
cp .env.example .env      # point DATABASE_URL at a Postgres you run yourself
npm ci
npm run lint
npm test                  # uses an in-memory Postgres, no database needed
npm start
```

## Configuration

| Variable | Local (Compose) | Production (Render) | Secret |
|---|---|---|---|
| `DATABASE_URL` | set in `compose.yaml` | Render dashboard (Supabase session pooler URL) | Yes |
| `DB_SSL` | `false` | `true` | No |
| `GEMINI_API_KEY` | shell variable, optional | Render dashboard | Yes |
| `GEMINI_MODEL` | default `gemini-2.5-flash` | `render.yaml` | No |
| `RENDER_DEPLOY_HOOK` | - | GitHub Actions secret | Yes |

## Failure behaviour

| Failure | What the user sees |
|---|---|
| Gemini returns 429 / times out / bad output | Offline study aids plus a notice explaining why |
| Database paused or restarting | Orange banner "database is waking up", automatic retry every 10 s |
| Server unreachable | Banner "Cannot reach the server" |

## API

- `GET /api/health` - 200 when the database answers, 503 otherwise
- `GET/POST /api/subjects`, `PUT/DELETE /api/subjects/:id`
- `GET/POST /api/notes` (`?subject_id=`), `PUT/DELETE /api/notes/:id`
- `GET/POST /api/flashcards` (`?note_id=`), `DELETE /api/flashcards/:id`
- `POST /api/ai/generate` with `{ note_id }` or `{ content }`, optional `mode`

## Team

| Member | Area |
|---|---|
| Luu Gia Bao (@bao-rblx) | Backend, PostgreSQL, database resilience, secret scanning |
| Tran Quang Minh | AI integration (Gemini), tests, CI/CD pipeline |
| Nguyen Trung Duc (@Kaizawa388222) | Frontend, Docker, Compose, Render deployment |
