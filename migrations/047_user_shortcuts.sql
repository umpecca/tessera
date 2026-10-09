CREATE TABLE IF NOT EXISTS user_shortcuts (
  user_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  shortcuts_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
