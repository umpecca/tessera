CREATE TABLE IF NOT EXISTS audio_station (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_kind TEXT NOT NULL DEFAULT '',
  source_value TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  pane_id TEXT NOT NULL DEFAULT '',
  position_seconds REAL NOT NULL DEFAULT 0,
  source_version INTEGER NOT NULL DEFAULT 0,
  state_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO audio_station (
  id, source_kind, source_value, workspace_id, pane_id,
  position_seconds, source_version, state_version, updated_at
) VALUES (1, '', '', '', '', 0, 0, 0, CURRENT_TIMESTAMP);
