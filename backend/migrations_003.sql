-- Run once in the Supabase SQL Editor. Safe to run again. Includes everything in migrations_002.sql.
-- Adds devices + tokens, live/offline-safe sessions, activity %, app usage, screenshots,
-- projects, leave & holidays, settings, and locks every table to the backend (RLS on, no policies).

-- ── 002: approve / reject adjustments ───────────────────────────────────────
ALTER TABLE adjustments ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE adjustments DROP CONSTRAINT IF EXISTS adjustments_status_check;
ALTER TABLE adjustments ADD CONSTRAINT adjustments_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'resolved'));
CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_adjustments_user   ON adjustments(user_id);

-- ── Settings: company-wide defaults + per-employee overrides ────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── Devices: one row per computer, each with its own token ──────────────────
CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
  token_hash      TEXT UNIQUE,
  hostname        TEXT,
  platform        TEXT,
  app_version     TEXT,
  consent_version INT,
  consent_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ,
  live_status     TEXT,
  live_category   TEXT,
  live_since      TIMESTAMPTZ,
  live_app        TEXT,
  live_project_id UUID
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- ── Projects ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  client     TEXT,
  archived   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Sessions: live updates, offline retries, categories, projects ───────────
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS device_id    UUID REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS client_id    UUID;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS category     TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS note         TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id   UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS activity_pct INT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS end_reason   TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_open      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_status_check CHECK (status IN ('active', 'idle', 'away'));
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_category_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_category_check
  CHECK (category IS NULL OR category IN ('meeting', 'break', 'lunch', 'other'));

-- The desktop app re-sends the same segment (live updates, retries); this makes that an update, not a duplicate
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sessions_device_client ON sessions(device_id, client_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_start ON sessions(user_id, start_time);

-- ── Activity level: seconds with keyboard/mouse input per 10-minute slot ────
CREATE TABLE IF NOT EXISTS activity_slots (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_start  TIMESTAMPTZ NOT NULL,
  active_secs INT NOT NULL DEFAULT 0,
  total_secs  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, slot_start)
);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_slots(user_id, slot_start);

-- ── App & website usage: seconds per app (and site, for browsers) per hour ──
CREATE TABLE IF NOT EXISTS app_usage (
  device_id  UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hour_start TIMESTAMPTZ NOT NULL,
  app        TEXT NOT NULL,
  label      TEXT NOT NULL DEFAULT '',
  seconds    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, hour_start, app, label)
);
CREATE INDEX IF NOT EXISTS idx_app_usage_user ON app_usage(user_id, hour_start);

CREATE TABLE IF NOT EXISTS app_categories (
  pattern  TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK (category IN ('productive', 'neutral', 'unproductive'))
);
INSERT INTO app_categories (pattern, category) VALUES
  ('code', 'productive'), ('devenv', 'productive'), ('idea64', 'productive'), ('github', 'productive'),
  ('stack overflow', 'productive'), ('excel', 'productive'), ('winword', 'productive'), ('powerpnt', 'productive'),
  ('outlook', 'productive'), ('teams', 'productive'), ('zoom', 'productive'), ('slack', 'productive'),
  ('figma', 'productive'), ('jira', 'productive'), ('notion', 'productive'), ('google docs', 'productive'),
  ('google sheets', 'productive'), ('gmail', 'productive'), ('meet', 'productive'), ('windowsterminal', 'productive'),
  ('explorer', 'neutral'), ('spotify', 'neutral'), ('whatsapp', 'neutral'),
  ('youtube', 'unproductive'), ('netflix', 'unproductive'), ('instagram', 'unproductive'),
  ('facebook', 'unproductive'), ('reddit', 'unproductive'), ('hotstar', 'unproductive'), ('prime video', 'unproductive')
ON CONFLICT (pattern) DO NOTHING;

-- ── Screenshots (images live in the private "screenshots" storage bucket) ───
CREATE TABLE IF NOT EXISTS screenshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID REFERENCES devices(id) ON DELETE SET NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_at     TIMESTAMPTZ NOT NULL,
  display      INT NOT NULL DEFAULT 0,
  path         TEXT NOT NULL,
  blurred      BOOLEAN NOT NULL DEFAULT FALSE,
  activity_pct INT,
  app          TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_screenshots_shot ON screenshots(device_id, taken_at, display);
CREATE INDEX IF NOT EXISTS idx_screenshots_user ON screenshots(user_id, taken_at);

INSERT INTO storage.buckets (id, name, public) VALUES ('screenshots', 'screenshots', false)
ON CONFLICT (id) DO NOTHING;

-- ── Attendance: leave per employee, company holidays ────────────────────────
CREATE TABLE IF NOT EXISTS leaves (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date    DATE NOT NULL,
  type    TEXT NOT NULL CHECK (type IN ('leave', 'sick', 'half_day', 'wfh')),
  note    TEXT,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE IF NOT EXISTS holidays (
  date DATE PRIMARY KEY,
  name TEXT NOT NULL
);

-- ── Only the backend (secret key) may read or write ─────────────────────────
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjustments    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices        ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_usage      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenshots    ENABLE ROW LEVEL SECURITY;
ALTER TABLE leaves         ENABLE ROW LEVEL SECURITY;
ALTER TABLE holidays       ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
