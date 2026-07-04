PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_pane_id TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Pane',
  buffer_text TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  x INTEGER NOT NULL DEFAULT 80,
  y INTEGER NOT NULL DEFAULT 80,
  width INTEGER NOT NULL DEFAULT 360,
  height INTEGER NOT NULL DEFAULT 240,
  z_index INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS command_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pane_id TEXT NOT NULL REFERENCES panes(id) ON DELETE CASCADE,
  command_text TEXT NOT NULL,
  cwd_before TEXT NOT NULL,
  cwd_after TEXT NOT NULL DEFAULT '',
  exit_code INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_panes_workspace_position ON panes(workspace_id, position);
CREATE INDEX IF NOT EXISTS idx_command_runs_workspace_started ON command_runs(workspace_id, started_at);
