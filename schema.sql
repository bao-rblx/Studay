-- Studay database schema (PostgreSQL)
-- Applied automatically on startup by src/db.js. Idempotent: safe to run on every boot.

CREATE TABLE IF NOT EXISTS subjects (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  color      TEXT        NOT NULL DEFAULT '#007aff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  subject_id INTEGER     NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS flashcards (
  id         SERIAL PRIMARY KEY,
  note_id    INTEGER     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  front      TEXT        NOT NULL,
  back       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_subject_id ON notes (subject_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_note_id ON flashcards (note_id);
