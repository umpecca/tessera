CREATE TABLE IF NOT EXISTS workspace_backgrounds (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  image BLOB NOT NULL,
  updated_at TEXT NOT NULL
);
