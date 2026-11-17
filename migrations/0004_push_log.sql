-- Diagnostics for mobile sync: keep the last few pushes per user so a stuck
-- outbox can be explained after the fact (rows older than 7 days are pruned by
-- the daily cron). Only ids and entity types are stored, never payload text.
CREATE TABLE IF NOT EXISTS sync_push_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  change_count INTEGER NOT NULL DEFAULT 0,
  accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  summary_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_log_user ON sync_push_log(user_id, created_at);
