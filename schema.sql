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

CREATE TABLE IF NOT EXISTS flashcards (
  id         SERIAL PRIMARY KEY,
  note_id    INTEGER     NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  front      TEXT        NOT NULL,
  back       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


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

CREATE INDEX IF NOT EXISTS idx_notes_subject_id ON notes (subject_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_note_id ON flashcards (note_id);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events (event_date);
CREATE INDEX IF NOT EXISTS idx_materials_subject_id ON materials (subject_id);
