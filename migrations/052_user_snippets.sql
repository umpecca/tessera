CREATE TABLE IF NOT EXISTS user_snippets (
  user_id TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  snippets_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
