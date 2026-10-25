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


## Team

- Luu Gia Bao - 2474802010028 - Backend + Database (`server.js`, `schema.sql`)
- Nguyen Trung Duc - 2474802010092 - Frontend (`public/`)
- Tran Quang Minh - 2474802010241 - AI Integration (`ai.js`, docs)
