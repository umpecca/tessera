CREATE TABLE IF NOT EXISTS auth_accounts (
  name TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
