# Studay - AI-Powered Study Companion

Final project for 72ITDS30103. A web app where students organise study
materials (subjects, notes, flashcards - full CRUD) and use an
AI-assisted feature to auto-generate summaries, flashcards, and quiz
questions from their notes. Redesigned in an Apple Liquid Glass aesthetic:
frosted-glass panels, aurora backdrop, pill controls, dark mode.

## Tech stack

- Backend: Node.js + Express
- Database: SQLite via Node.js built-in `node:sqlite` (requires Node 22.5+, zero-config, file-based)
- Frontend: HTML / CSS / vanilla JS (Liquid Glass design system in `public/styles.css`)
- AI: offline extractive MVP in `ai.js` (keyword-weighted summaries, cloze flashcards, same-note quiz distractors; drop-in point for OpenAI API via `OPENAI_API_KEY`)

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000

## API overview

- `GET/POST /api/subjects`, `PUT/DELETE /api/subjects/:id`
- `GET/POST /api/notes` (+ `?subject_id=`), `PUT/DELETE /api/notes/:id`
- `GET/POST /api/flashcards` (+ `?note_id=`), `DELETE /api/flashcards/:id`
- `POST /api/ai/generate` with `{ note_id }` or `{ content }`, optional `mode: summary|flashcards|quiz|all` (400 if text missing or under 30 chars; long input truncated to 12k chars)
## Project checklist

Tick an item only when its PR is merged into `main` and CI is green.

### Phase 1: Foundation (weeks 3-4)

- [x] Bao: migrate to PostgreSQL with pool, health check, error handling
- [x] Minh: ESLint and API tests
- [x] Minh: CI workflow with `lint`, `test`, `build` jobs 
- [x] Duc: Dockerfile, `.dockerignore`, Compose stack
- [x] Duc: enforce LF line endings

### Phase 2: Cloud and AI (weeks 5-8)

- [x] Bao: Supabase project (Session pooler connection string)
- [x] Duc: Render web service (Docker, Free, Auto-Deploy off)
- [x] Minh: GitHub secret `RENDER_DEPLOY_HOOK` and variable `APP_URL`
- [x] Minh: Gemini API with timeout, 429 and offline fallback
- [x] Bao: survive database pause, startup retry and 503 responses
- [x] Minh: deploy job triggers Render on merge to `main` 
- [x] Minh: fix `APP_URL` - remove the trailing `/`, otherwise the health check hits `//api/health` (404) and the `deploy` job fails
- [x] Duc: frontend failure states, AI notice, Render blueprint

### Phase 3: Security, process, docs (weeks 9-10)

- [ ] Bao: gitleaks secret scanning of files and full Git history
- [ ] Minh: PR and issue templates, `CODEOWNERS` (real GitHub username)
- [ ] Duc: README with architecture diagram, config table, failure table; `docs/DEMO.md` with the real URL
- [ ] Minh: deliberately failing PR for the demo (red check, merge blocked), fixed on demo day

### Report (12 pages, PDF)

- [ ] 1. Platform choice - Duc
- [ ] 2. Architecture - Duc
- [ ] 3. Dockerfile and Compose - Duc
- [ ] 4. CI/CD - Minh
- [ ] 5. Database - Bao
- [ ] 6. AI - Minh
- [ ] 7. Secrets and configuration - Bao
- [ ] 8. Contribution table (real commit/PR counts, signed) - Team

## Team

- Luu Gia Bao - 2474802010028 - Backend + Database (`server.js`, `schema.sql`)
- Nguyen Trung Duc - 2474802010092 - Frontend (`public/`)
- Tran Quang Minh - 2474802010241 - AI Integration (`ai.js`, docs)
