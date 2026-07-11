PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  active_pane_id TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{}',
  background_mode TEXT NOT NULL DEFAULT 'fill',
  default_pane_font_size INTEGER NOT NULL DEFAULT 14,
  default_theme TEXT NOT NULL DEFAULT 'next-tessera',
  theme_id TEXT NOT NULL DEFAULT 'next-tessera',
  last_opened_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY,
  default_pane_font_size INTEGER NOT NULL DEFAULT 14,
  default_theme TEXT NOT NULL DEFAULT 'next-tessera',
  theme_id TEXT NOT NULL DEFAULT 'next-tessera',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'worksheet',
  title TEXT NOT NULL DEFAULT 'Pane',
  buffer_text TEXT NOT NULL DEFAULT '',
  editor_mode TEXT NOT NULL DEFAULT '',
  font_size INTEGER NOT NULL DEFAULT 14,
  cwd TEXT NOT NULL DEFAULT '',
  last_export_path TEXT NOT NULL DEFAULT '',
  file_browser_sidebar_width INTEGER NOT NULL DEFAULT 200,
  is_full INTEGER NOT NULL DEFAULT 0,
  restore_box TEXT NOT NULL DEFAULT '',
  minimized INTEGER NOT NULL DEFAULT 0,
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_owner_name ON workspaces(owner_id, name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner_opened ON workspaces(owner_id, last_opened_at DESC);
