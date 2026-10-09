package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func TestRetireFileBrowserPreservesLayoutAndRejectsStaleSave(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "old.db"))
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
		if migration.version >= 45 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	ws := &Workspace{ID: "default", ActivePaneID: "files", Panes: []Pane{{ID: "files", Kind: "terminal", Title: "Project files", Cwd: "/project", Minimized: true, X: 14, Y: 23, Width: 400, Height: 300}, {ID: "notes", Kind: "worksheet", BufferText: "unsaved notes"}}}
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatal(err)
	}
	other := &Workspace{ID: "other", Panes: []Pane{{ID: "editor", Kind: "text-editor", BufferText: "keep"}}}
	if err := st.SaveWorkspace(ctx, other); err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `UPDATE panes SET kind='file-browser' WHERE id='files'; UPDATE workspaces SET layout_json='{"panes":["files","notes"],"custom":"keep"}' WHERE id='default';`)
	if err != nil {
		t.Fatal(err)
	}
	stale, err := st.LoadOrCreateWorkspace(ctx, "default", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := st.LoadOrCreateWorkspace(ctx, "default", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision == stale.Revision || got.ActivePaneID != "files" || got.Panes[0].Kind != "terminal" || got.Panes[0].Cwd != "/project" || got.Panes[0].Title != "Project files" || !got.Panes[0].Minimized || got.Panes[0].X != 14 || got.Panes[1].BufferText != "unsaved notes" {
		t.Fatalf("bad conversion %+v", got)
	}
	if string(got.Layout) != string(stale.Layout) {
		t.Fatal("layout changed")
	}
	if err := st.SaveWorkspace(ctx, stale); !errors.Is(err, ErrWorkspaceConflict) {
		t.Fatal("stale save accepted", err)
	}
	unchanged, _ := st.LoadOrCreateWorkspace(ctx, "other", "")
	if unchanged.Revision != other.Revision || unchanged.Panes[0].BufferText != "keep" {
		t.Fatal("unrelated workspace changed")
	}
	imported := &Workspace{ID: "import", Panes: []Pane{{ID: "legacy", Kind: "file-browser", Cwd: "/import"}}}
	if err := st.SaveWorkspace(ctx, imported); err != nil {
		t.Fatal(err)
	}
	loaded, _ := st.LoadOrCreateWorkspace(ctx, "import", "")
	if loaded.Panes[0].Kind != "terminal" || loaded.Panes[0].Cwd != "/import" {
		t.Fatal("legacy import not converted")
	}
}
