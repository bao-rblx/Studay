-- Studay database schema (PostgreSQL)
-- Applied automatically on startup by src/db.js. Idempotent: safe to run on every boot,
-- including on an existing database (new columns use ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS subjects (
  id         SERIAL PRIMARY KEY,
  name       TEXT        NOT NULL,
  color      TEXT        NOT NULL DEFAULT '#007aff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Filled by hand or by the AI timetable scan.
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS teacher TEXT;
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS room TEXT;
-- Weekly classes: [{"day": 0-6 (0 = Sunday), "start": "HH:MM", "end": "HH:MM", "room": "..."}]
ALTER TABLE subjects ADD COLUMN IF NOT EXISTS schedule JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  subject_id INTEGER     NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Flashcards were replaced by quizzes.
DROP TABLE IF EXISTS flashcards;

-- Calendar entries: deadlines, exams, presentations... One row per day.
CREATE TABLE IF NOT EXISTS events (
  id         SERIAL PRIMARY KEY,
  subject_id INTEGER     REFERENCES subjects(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  kind       TEXT        NOT NULL DEFAULT 'other',
  event_date DATE        NOT NULL,
  start_time TEXT,
  details    TEXT,
  done       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Teacher files (PDF, slides, text). Only the extracted text and the AI summary are kept,
-- not the original file.
CREATE TABLE IF NOT EXISTS materials (
  id         SERIAL PRIMARY KEY,
  subject_id INTEGER     NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  filename   TEXT,
  content    TEXT        NOT NULL,
  summary    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts. One row per person; everything else belongs to exactly one of these.
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  display_name  TEXT,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per signed-in device. Only the SHA-256 of the cookie value is stored, so a
-- database leak cannot be replayed as a live session.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT        PRIMARY KEY,
  user_id    INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Tenancy. NULL means "created before accounts existed"; the first account to register
-- claims those rows (see src/routes/auth.js), which keeps one-device data from being lost.
ALTER TABLE subjects  ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE notes     ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE events    ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE materials ADD COLUMN IF NOT EXISTS user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_notes_subject_id ON notes (subject_id);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events (event_date);
CREATE INDEX IF NOT EXISTS idx_materials_subject_id ON materials (subject_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_subjects_user_id ON subjects (user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user_id ON notes (user_id);
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events (user_id);
CREATE INDEX IF NOT EXISTS idx_materials_user_id ON materials (user_id);
