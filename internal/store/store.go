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
  name TEXT NOT NULL,
  active_pane_id TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS panes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'worksheet',
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
	return nil
}

func (s *Store) ensurePaneGeometryColumns(ctx context.Context) error {
	columns, err := s.tableColumns(ctx, "panes")
	if err != nil {
		return err
	}
	additions := map[string]string{
		"kind":    "ALTER TABLE panes ADD COLUMN kind TEXT NOT NULL DEFAULT 'worksheet'",
		"x":       "ALTER TABLE panes ADD COLUMN x INTEGER NOT NULL DEFAULT 80",
		"y":       "ALTER TABLE panes ADD COLUMN y INTEGER NOT NULL DEFAULT 80",
		"width":   "ALTER TABLE panes ADD COLUMN width INTEGER NOT NULL DEFAULT 360",
		"height":  "ALTER TABLE panes ADD COLUMN height INTEGER NOT NULL DEFAULT 240",
		"z_index": "ALTER TABLE panes ADD COLUMN z_index INTEGER NOT NULL DEFAULT 0",
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
