package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

const initSQL = `
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

CREATE TABLE IF NOT EXISTS workspace_backgrounds (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL,
  image BLOB NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_panes_workspace_position ON panes(workspace_id, position);
CREATE INDEX IF NOT EXISTS idx_command_runs_workspace_started ON command_runs(workspace_id, started_at);
`

func Open(ctx context.Context, path string) (*Store, error) {
	if path == "" {
		return nil, errors.New("database path is required")
	}
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	store := &Store{db: db}
	if err := store.migrate(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate(ctx context.Context) error {
	if _, err := s.db.ExecContext(ctx, "PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;"); err != nil {
		return fmt.Errorf("configure sqlite: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, initSQL); err != nil {
		return fmt.Errorf("migrate sqlite: %w", err)
	}
	if err := s.ensurePaneGeometryColumns(ctx); err != nil {
		return err
	}
	if err := s.ensureWorkspaceColumns(ctx); err != nil {
		return err
	}
	return nil
}

func (s *Store) ensureWorkspaceColumns(ctx context.Context) error {
	columns, err := s.tableColumns(ctx, "workspaces")
	if err != nil {
		return err
	}
	hadOwnerID := columns["owner_id"]
	additions := map[string]string{
		"owner_id":               "ALTER TABLE workspaces ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''",
		"last_opened_at":         "ALTER TABLE workspaces ADD COLUMN last_opened_at TEXT NOT NULL DEFAULT ''",
		"background_mode":        "ALTER TABLE workspaces ADD COLUMN background_mode TEXT NOT NULL DEFAULT 'fill'",
		"default_pane_font_size": "ALTER TABLE workspaces ADD COLUMN default_pane_font_size INTEGER NOT NULL DEFAULT 14",
		"default_theme":          "ALTER TABLE workspaces ADD COLUMN default_theme TEXT NOT NULL DEFAULT 'next-tessera'",
		"theme_id":               "ALTER TABLE workspaces ADD COLUMN theme_id TEXT NOT NULL DEFAULT 'next-tessera'",
	}
	for name, statement := range additions {
		if columns[name] {
			continue
		}
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add workspaces.%s column: %w", name, err)
		}
	}
	if !hadOwnerID {
		if _, err := s.db.ExecContext(ctx, `
UPDATE workspaces
SET owner_id = id,
    name = 'Default',
    last_opened_at = CASE WHEN last_opened_at = '' THEN updated_at ELSE last_opened_at END`); err != nil {
			return fmt.Errorf("migrate legacy workspaces to sessions: %w", err)
		}
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO user_settings (user_id, default_pane_font_size, default_theme, theme_id, created_at, updated_at)
SELECT owner_id, default_pane_font_size, default_theme, theme_id, created_at, updated_at
FROM workspaces`); err != nil {
			return fmt.Errorf("migrate workspace settings to users: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_owner_name ON workspaces(owner_id, name COLLATE NOCASE)`); err != nil {
		return fmt.Errorf("index workspace session names: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_workspaces_owner_opened ON workspaces(owner_id, last_opened_at DESC)`); err != nil {
		return fmt.Errorf("index workspace sessions by recent use: %w", err)
	}
	return nil
}

func (s *Store) ensurePaneGeometryColumns(ctx context.Context) error {
	columns, err := s.tableColumns(ctx, "panes")
	if err != nil {
		return err
	}
	additions := map[string]string{
		"kind":                       "ALTER TABLE panes ADD COLUMN kind TEXT NOT NULL DEFAULT 'worksheet'",
		"x":                          "ALTER TABLE panes ADD COLUMN x INTEGER NOT NULL DEFAULT 80",
		"y":                          "ALTER TABLE panes ADD COLUMN y INTEGER NOT NULL DEFAULT 80",
		"width":                      "ALTER TABLE panes ADD COLUMN width INTEGER NOT NULL DEFAULT 360",
		"height":                     "ALTER TABLE panes ADD COLUMN height INTEGER NOT NULL DEFAULT 240",
		"z_index":                    "ALTER TABLE panes ADD COLUMN z_index INTEGER NOT NULL DEFAULT 0",
		"last_export_path":           "ALTER TABLE panes ADD COLUMN last_export_path TEXT NOT NULL DEFAULT ''",
		"file_browser_sidebar_width": "ALTER TABLE panes ADD COLUMN file_browser_sidebar_width INTEGER NOT NULL DEFAULT 200",
		"is_full":                    "ALTER TABLE panes ADD COLUMN is_full INTEGER NOT NULL DEFAULT 0",
		"restore_box":                "ALTER TABLE panes ADD COLUMN restore_box TEXT NOT NULL DEFAULT ''",
		"editor_mode":                "ALTER TABLE panes ADD COLUMN editor_mode TEXT NOT NULL DEFAULT ''",
		"font_size":                  "ALTER TABLE panes ADD COLUMN font_size INTEGER NOT NULL DEFAULT 14",
		"minimized":                  "ALTER TABLE panes ADD COLUMN minimized INTEGER NOT NULL DEFAULT 0",
	}
	for name, statement := range additions {
		if columns[name] {
			continue
		}
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add panes.%s column: %w", name, err)
		}
	}
	return nil
}

func (s *Store) tableColumns(ctx context.Context, table string) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, "PRAGMA table_info("+table+")")
	if err != nil {
		return nil, fmt.Errorf("inspect %s columns: %w", table, err)
	}
	defer rows.Close()

	columns := make(map[string]bool)
	for rows.Next() {
		var cid int
		var name, columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return nil, fmt.Errorf("scan %s column: %w", table, err)
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate %s columns: %w", table, err)
	}
	return columns, nil
}

func nowText() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
