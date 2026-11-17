-- BeeCount Cloud Worker — D1 schema (initial)
-- Mirrors the PostgreSQL/SQLite schema of BeeCount-Cloud 1.9.0, reduced to the
-- tables the HTTP API actually uses.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  totp_secret TEXT,
  totp_enabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_file_id TEXT,
  avatar_version INTEGER NOT NULL DEFAULT 0,
  income_is_red INTEGER,
  theme_primary_color TEXT,
  appearance_json TEXT,
  ai_config_json TEXT,
  primary_currency TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  client_type TEXT NOT NULL DEFAULT 'app',
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Unknown Device',
  platform TEXT NOT NULL DEFAULT 'unknown',
  app_version TEXT,
  os_version TEXT,
  device_model TEXT,
  last_ip TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_pats_user ON personal_access_tokens(user_id);

CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  month_start_day INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  exported_at TEXT,
  UNIQUE (user_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ledgers_owner ON ledgers(user_id);

CREATE TABLE IF NOT EXISTS ledger_members (
  ledger_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON ledger_members(user_id);

CREATE TABLE IF NOT EXISTS ledger_invites (
  code TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor',
  expires_at TEXT,
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ledger_id TEXT,
  scope TEXT NOT NULL DEFAULT 'ledger',
  entity_type TEXT NOT NULL,
  entity_sync_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  updated_by_device_id TEXT,
  updated_by_user_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_ledger ON sync_changes(ledger_id, change_id);
CREATE INDEX IF NOT EXISTS idx_changes_user_scope ON sync_changes(user_id, scope, change_id);
CREATE INDEX IF NOT EXISTS idx_changes_entity ON sync_changes(scope, entity_type, entity_sync_id, change_id);
CREATE INDEX IF NOT EXISTS idx_changes_created ON sync_changes(created_at);

CREATE TABLE IF NOT EXISTS read_tx (
  ledger_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  tx_type TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  happened_at TEXT NOT NULL,
  note TEXT,
  category_sync_id TEXT,
  category_name TEXT,
  category_kind TEXT,
  account_sync_id TEXT,
  account_name TEXT,
  from_account_sync_id TEXT,
  from_account_name TEXT,
  to_account_sync_id TEXT,
  to_account_name TEXT,
  tags_csv TEXT,
  tag_sync_ids_json TEXT,
  attachments_json TEXT,
  tx_index INTEGER NOT NULL DEFAULT 0,
  currency_code TEXT,
  native_amount REAL,
  exclude_from_stats INTEGER NOT NULL DEFAULT 0,
  exclude_from_budget INTEGER NOT NULL DEFAULT 0,
  created_by_user_id TEXT,
  last_edited_by_user_id TEXT,
  source_change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ledger_id, sync_id)
);
CREATE INDEX IF NOT EXISTS idx_read_tx_time ON read_tx(ledger_id, happened_at);

CREATE TABLE IF NOT EXISTS user_accounts (
  user_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT,
  currency TEXT,
  initial_balance REAL,
  note TEXT,
  credit_limit REAL,
  billing_day INTEGER,
  payment_due_day INTEGER,
  bank_name TEXT,
  card_last_four TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  source_change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, sync_id)
);

CREATE TABLE IF NOT EXISTS user_categories (
  user_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  level INTEGER,
  sort_order INTEGER,
  icon TEXT,
  icon_type TEXT,
  custom_icon_path TEXT,
  icon_cloud_file_id TEXT,
  icon_cloud_sha256 TEXT,
  parent_name TEXT,
  parent_sync_id TEXT,
  source_change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, sync_id)
);

CREATE TABLE IF NOT EXISTS user_tags (
  user_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  source_change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, sync_id)
);

CREATE TABLE IF NOT EXISTS read_budgets (
  ledger_id TEXT NOT NULL,
  sync_id TEXT NOT NULL,
  budget_type TEXT NOT NULL DEFAULT 'total',
  category_sync_id TEXT,
  amount REAL NOT NULL DEFAULT 0,
  period TEXT NOT NULL DEFAULT 'monthly',
  start_day INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_change_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ledger_id, sync_id)
);

CREATE TABLE IF NOT EXISTS exchange_rate_overrides (
  user_id TEXT NOT NULL,
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  sync_id TEXT,
  updated_at TEXT,
  PRIMARY KEY (user_id, base_currency, quote_currency)
);

CREATE TABLE IF NOT EXISTS exchange_rate_cache (
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (base_currency, quote_currency)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ledger_id TEXT,
  kind TEXT NOT NULL DEFAULT 'transaction',
  sha256 TEXT NOT NULL,
  file_name TEXT,
  original_name TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  width INTEGER,
  height INTEGER,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, sha256, kind)
);
CREATE INDEX IF NOT EXISTS idx_attachments_ledger ON attachments(ledger_id);

CREATE TABLE IF NOT EXISTS sync_cursors (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  ledger_external_id TEXT NOT NULL,
  last_cursor INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, ledger_external_id)
);

CREATE TABLE IF NOT EXISTS sync_push_idempotency (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, device_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  ledger_id TEXT,
  action TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);

CREATE TABLE IF NOT EXISTS import_jobs (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  file_name TEXT,
  headers_json TEXT NOT NULL,
  rows_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  int_value INTEGER NOT NULL DEFAULT 0,
  text_value TEXT
);
INSERT OR IGNORE INTO app_meta (key, int_value) VALUES ('change_seq', 0);
