package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestPaneColorModesPersistIndependently(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "colors.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	ws := &Workspace{ID: "colors", Panes: []Pane{
		{ID: "light", TerminalColorMode: "light"},
		{ID: "dark", TerminalColorMode: "dark"},
		{ID: "default"},
		{ID: "invalid", TerminalColorMode: "unknown"},
	}}
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	st, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	loaded, err := st.LoadWorkspace(ctx, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, want := range []string{"light", "dark", "", ""} {
		if loaded.Panes[i].TerminalColorMode != want {
			t.Fatalf("pane %s mode = %q, want %q", loaded.Panes[i].ID, loaded.Panes[i].TerminalColorMode, want)
		}
		pane, err := st.LoadPane(ctx, ws.ID, loaded.Panes[i].ID)
		if err != nil || pane.TerminalColorMode != want {
			t.Fatalf("load pane %s: %+v, %v", loaded.Panes[i].ID, pane, err)
		}
	}
	loaded.Panes[0].TerminalColorMode = ""
	if err := st.SaveWorkspace(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	pane, err := st.LoadPane(ctx, ws.ID, "light")
	if err != nil || pane.TerminalColorMode != "" {
		t.Fatalf("reset mode: %+v, %v", pane, err)
	}
}

func TestPaneColorMigrationPreservesLegacyPaneAndDefaultsToInheritance(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "legacy.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	st := &Store{db: db}
	defer st.Close()
	migrations, err := loadMigrations()
	if err != nil {
		t.Fatal(err)
	}
	for _, migration := range migrations {
		if migration.version >= 48 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO workspaces (id, name, revision, created_at, updated_at) VALUES ('legacy', 'Legacy', 'revision', 'before', 'before');
INSERT INTO panes (id, workspace_id, kind, title, cwd, buffer_text, x, y, width, height, created_at, updated_at)
VALUES ('shell', 'legacy', 'terminal', 'Build', '/project', 'archived', 10, 20, 640, 360, 'before', 'before');`); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	ws, err := st.LoadWorkspace(ctx, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	pane := ws.Panes[0]
	if ws.Revision != "revision" || pane.TerminalColorMode != "" || pane.Title != "Build" || pane.Cwd != "/project" || pane.BufferText != "archived" || pane.X != 10 || pane.Y != 20 || pane.Width != 640 || pane.Height != 360 {
		t.Fatalf("migration changed legacy workspace: %+v, %+v", ws, pane)
	}
}
