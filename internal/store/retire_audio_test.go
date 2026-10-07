package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestRetireAudioMigrationPreservesWorkspaceContentAndInvalidatesStaleSaves(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "before-audio-retirement.sqlite3")
	db, err := sql.Open("sqlite", path)
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
		if migration.version >= 44 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	for _, ws := range []*Workspace{
		{ID: "mixed", Name: "Project", BackgroundMode: "fit", ThemeID: "operator", ActivePaneID: "shell", Panes: []Pane{
			{ID: "shell", Kind: "terminal", Title: "Build", Cwd: "C:/project"},
			{ID: "notes", Kind: "worksheet", BufferText: "keep these notes", EditorTabs: `[{"text":"draft"}]`},
		}},
		{ID: "unaffected", Name: "Other", Panes: []Pane{{ID: "editor", Kind: "text-editor", BufferText: "unsaved document"}}},
		{ID: "audio-only", Name: "Listening"},
		{ID: "odd-layout", Name: "Legacy layout"},
	} {
		if err := st.SaveWorkspace(ctx, ws); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.SaveWorkspaceBackground(ctx, "mixed", "image/png", []byte("background")); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveUserSettings(ctx, &UserSettings{UserID: "alice", TerminalFont: "fira-code", TerminalRowSpacing: "comfortable"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `
INSERT INTO panes (id, workspace_id, kind, position, created_at, updated_at)
VALUES ('old-audio', 'mixed', 'audio', 0, 'before', 'before'),
       ('only-audio', 'audio-only', 'audio', 0, 'before', 'before'),
       ('odd-audio', 'odd-layout', 'audio', 0, 'before', 'before');
UPDATE workspaces SET active_pane_id = 'old-audio', layout_json = '{"panes":["old-audio","shell","notes"],"custom":"keep"}' WHERE id = 'mixed';
UPDATE workspaces SET active_pane_id = 'only-audio', layout_json = '{"panes":["only-audio"]}' WHERE id = 'audio-only';
UPDATE workspaces SET layout_json = 'not-json' WHERE id = 'odd-layout';
INSERT INTO command_runs (id, workspace_id, pane_id, command_text, cwd_before, started_at)
VALUES ('run', 'mixed', 'notes', 'echo hello', '/', 'before');
UPDATE audio_station SET source_kind = 'file', source_value = '/music.mp3';`); err != nil {
		t.Fatal(err)
	}
	stale, err := st.LoadOrCreateWorkspace(ctx, "mixed", "")
	if err != nil {
		t.Fatal(err)
	}
	other, err := st.LoadOrCreateWorkspace(ctx, "unaffected", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if exists, err := st.tableExists(ctx, "audio_station"); err != nil || exists {
		t.Fatalf("station remains: %v %v", exists, err)
	}
	got, err := st.LoadOrCreateWorkspace(ctx, "mixed", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision == stale.Revision || got.ActivePaneID != "shell" || len(got.Panes) != 2 || got.Name != "Project" || got.ThemeID != "operator" {
		t.Fatalf("migrated workspace = %+v", got)
	}
	if got.Panes[0].Cwd != "C:/project" || got.Panes[1].BufferText != "keep these notes" || got.Panes[1].EditorTabs != `[{"text":"draft"}]` {
		t.Fatalf("pane content changed: %+v", got.Panes)
	}
	if string(got.Layout) != `{"panes":["shell","notes"],"custom":"keep"}` {
		t.Fatalf("migrated layout = %s", got.Layout)
	}
	background, err := st.LoadWorkspaceBackground(ctx, "mixed")
	if err != nil || string(background.Image) != "background" {
		t.Fatalf("background changed: %+v %v", background, err)
	}
	settings, err := st.LoadUserSettings(ctx, "alice")
	if err != nil || settings.TerminalFont != "fira-code" || settings.TerminalRowSpacing != "comfortable" {
		t.Fatalf("settings changed: %+v %v", settings, err)
	}
	var run string
	if err := db.QueryRowContext(ctx, "SELECT command_text FROM command_runs WHERE id = 'run'").Scan(&run); err != nil || run != "echo hello" {
		t.Fatalf("command run changed: %q %v", run, err)
	}
	unaffected, err := st.LoadOrCreateWorkspace(ctx, "unaffected", "")
	if err != nil || unaffected.Revision != other.Revision || unaffected.Panes[0].BufferText != "unsaved document" {
		t.Fatalf("unaffected workspace changed: %+v %v", unaffected, err)
	}
	empty, err := st.LoadOrCreateWorkspace(ctx, "audio-only", "")
	if err != nil || empty.ActivePaneID != "" || len(empty.Panes) != 0 || string(empty.Layout) != `{"panes":[]}` {
		t.Fatalf("audio-only workspace = %+v %v", empty, err)
	}
	var legacyLayout string
	if err := db.QueryRowContext(ctx, "SELECT layout_json FROM workspaces WHERE id = 'odd-layout'").Scan(&legacyLayout); err != nil || legacyLayout != "not-json" {
		t.Fatalf("legacy layout was modified: %q %v", legacyLayout, err)
	}
	if err := st.SaveWorkspace(ctx, stale); !errors.Is(err, ErrWorkspaceConflict) {
		t.Fatalf("stale save = %v", err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	loaded, err := reopened.LoadOrCreateWorkspace(ctx, "mixed", "")
	if err != nil || loaded.Revision != got.Revision || len(loaded.Panes) != 2 {
		t.Fatalf("reopened workspace = %+v %v", loaded, err)
	}
}

func TestSavingLegacyDocumentDropsAudioPanes(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "legacy-import.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ws := &Workspace{ID: "imported", ActivePaneID: "audio", Layout: json.RawMessage(`{"panes":["audio","terminal","worksheet"],"custom":"keep"}`), Panes: []Pane{
		{ID: "audio", Kind: "audio"},
		{ID: "terminal", Kind: "terminal"},
		{ID: "worksheet", Kind: "worksheet", BufferText: "notes"},
	}}
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	loaded, err := st.LoadOrCreateWorkspace(ctx, ws.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ActivePaneID != "terminal" || len(loaded.Panes) != 2 || loaded.Panes[1].BufferText != "notes" {
		t.Fatalf("legacy import = %+v", loaded)
	}
	if string(loaded.Layout) != `{"custom":"keep","panes":["terminal","worksheet"]}` {
		t.Fatalf("imported layout = %s", loaded.Layout)
	}
}
