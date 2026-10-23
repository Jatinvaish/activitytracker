-- Run once in the Supabase SQL Editor, after migrations.sql. Safe to run again.
-- Lets the admin console approve/reject requests and keep requests whose session was deleted.

ALTER TABLE adjustments ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE adjustments DROP CONSTRAINT IF EXISTS adjustments_status_check;
ALTER TABLE adjustments ADD CONSTRAINT adjustments_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'resolved'));

CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_adjustments_user   ON adjustments(user_id);
