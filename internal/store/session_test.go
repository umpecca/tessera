package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestSessionCRUDAndUserSettings(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	first, err := st.EnsureUserDefaultSession(ctx, "alice")
	if err != nil {
		t.Fatalf("ensure default session: %v", err)
	}
	if first.Name != "Default" || first.UserID != "alice" {
		t.Fatalf("default session = %+v", first)
	}
	second, err := st.CreateSession(ctx, "alice", "  Project  ")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if second.Name != "Project" || second.ID == first.ID {
		t.Fatalf("created session = %+v", second)
	}
	if _, err := st.CreateSession(ctx, "alice", "project"); !errors.Is(err, ErrSessionNameExists) {
		t.Fatalf("duplicate name error = %v", err)
	}
	if _, err := st.CreateSession(ctx, "alice", "   "); !errors.Is(err, ErrInvalidSessionName) {
		t.Fatalf("blank name error = %v", err)
	}

	renamed, err := st.RenameSession(ctx, "alice", second.ID, "Work")
	if err != nil || renamed.Name != "Work" {
		t.Fatalf("rename session = %+v, %v", renamed, err)
	}
	if err := st.ActivateSession(ctx, "alice", first.ID); err != nil {
		t.Fatalf("activate session: %v", err)
	}
	if err := st.DeleteSession(ctx, "alice", second.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	if err := st.DeleteSession(ctx, "alice", first.ID); !errors.Is(err, ErrLastSession) {
		t.Fatalf("delete final session error = %v", err)
	}
	if _, err := st.Session(ctx, "alice", second.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted session lookup error = %v", err)
	}

	settings := &UserSettings{UserID: "alice", DefaultPaneFontSize: 18, DefaultTheme: "studio", ThemeID: "hacker"}
	if err := st.SaveUserSettings(ctx, settings); err != nil {
		t.Fatalf("save settings: %v", err)
	}
	loaded, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load settings: %v", err)
	}
	if loaded.DefaultPaneFontSize != 18 || loaded.DefaultTheme != "studio" || loaded.ThemeID != "hacker" {
		t.Fatalf("loaded settings = %+v", loaded)
	}
}

func TestLegacyWorkspaceMigratesToDefaultSession(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "legacy.sqlite3")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open legacy database: %v", err)
	}
	_, err = db.Exec(`
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_pane_id TEXT NOT NULL DEFAULT '',
  layout_json TEXT NOT NULL DEFAULT '{}',
  background_mode TEXT NOT NULL DEFAULT 'fill',
  default_pane_font_size INTEGER NOT NULL DEFAULT 14,
  default_theme TEXT NOT NULL DEFAULT 'next-tessera',
  theme_id TEXT NOT NULL DEFAULT 'next-tessera',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO workspaces (id, name, default_pane_font_size, default_theme, theme_id, created_at, updated_at)
VALUES ('alice', 'alice', 18, 'studio', 'hacker', '2026-01-01', '2026-01-02');`)
	if err != nil {
		t.Fatalf("create legacy database: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close legacy database: %v", err)
	}

	st, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("migrate store: %v", err)
	}
	defer st.Close()
	sessions, err := st.ListSessions(ctx, "alice")
	if err != nil {
		t.Fatalf("list migrated sessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "alice" || sessions[0].Name != "Default" {
		t.Fatalf("migrated sessions = %+v", sessions)
	}
	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil {
		t.Fatalf("load migrated settings: %v", err)
	}
	if settings.DefaultPaneFontSize != 18 || settings.DefaultTheme != "studio" || settings.ThemeID != "hacker" {
		t.Fatalf("migrated settings = %+v", settings)
	}
}
