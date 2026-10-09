package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRetireEditorsPreservesDocumentsLayoutAndRevisions(t *testing.T) {
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
		if migration.version >= 46 {
			break
		}
		if err := st.applyMigration(ctx, migration); err != nil {
			t.Fatal(err)
		}
	}
	legacy := &Workspace{ID: "legacy", ActivePaneID: "editor", Layout: json.RawMessage(`{"panes":["notes","editor","blank"],"custom":"keep"}`), Panes: []Pane{
		{ID: "notes", Kind: "terminal", Title: "Notes", BufferText: "do not run this\n世界", Cwd: "/notes", EditorMode: "free", X: 19, Y: 37, Width: 450, Height: 320, ZIndex: 8, Minimized: true},
		{ID: "editor", Kind: "terminal", Title: "Draft", BufferText: "unsaved draft", EditorTabs: `{"active":1,"tabs":[{"text":"first"},{"path":"/draft.txt","text":"unsaved draft"}]}`, LastExportPath: "/draft.txt", EditorMode: "normal", Cwd: "/project", X: 23, Y: 54, Width: 520, Height: 410, ZIndex: 13, IsFull: true, RestoreBox: `{"x":23,"y":54,"width":520,"height":410}`},
		{ID: "blank", Kind: "terminal", Title: "Legacy", Width: 360, Height: 240, BufferText: "legacy default kind"},
	}}
	if err := st.SaveWorkspace(ctx, legacy); err != nil {
		t.Fatal(err)
	}
	other := &Workspace{ID: "other", Panes: []Pane{{ID: "browser", Kind: "browser", BrowserURL: "http://localhost:5000"}, {ID: "vnc", Kind: "vnc", VNCTarget: "localhost:5900"}}}
	if err := st.SaveWorkspace(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE panes SET kind='worksheet' WHERE id='notes'; UPDATE panes SET kind='text-editor' WHERE id='editor'; UPDATE panes SET kind='' WHERE id='blank';`); err != nil {
		t.Fatal(err)
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	got, err := st.LoadWorkspace(ctx, legacy.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Revision == legacy.Revision || got.ActivePaneID != legacy.ActivePaneID || string(got.Layout) != string(legacy.Layout) {
		t.Fatalf("workspace changed incorrectly: %+v", got)
	}
	for i, pane := range got.Panes {
		want := legacy.Panes[i]
		want.Position = i
		want.VNCScaleMode = "fit"
		if !reflect.DeepEqual(pane, want) {
			t.Fatalf("pane changed beyond kind: got %+v want %+v", pane, want)
		}
	}
	if err := st.SaveWorkspace(ctx, legacy); !errors.Is(err, ErrWorkspaceConflict) {
		t.Fatalf("stale save accepted: %v", err)
	}
	unchanged, err := st.LoadWorkspace(ctx, other.ID)
	if err != nil || unchanged.Revision != other.Revision {
		t.Fatalf("unaffected workspace revision changed: %+v %v", unchanged, err)
	}
	// A geometry save omits archived documents; subsequent loads must retain them.
	for i := range got.Panes {
		got.Panes[i].BufferText = ""
		got.Panes[i].EditorTabs = ""
		got.Panes[i].BufferTextUnchanged = true
		got.Panes[i].EditorTabsUnchanged = true
		got.Panes[i].X += 10
	}
	if err := st.SaveWorkspace(ctx, got); err != nil {
		t.Fatal(err)
	}
	reloaded, err := st.LoadWorkspace(ctx, got.ID)
	if err != nil {
		t.Fatal(err)
	}
	for i, pane := range reloaded.Panes {
		if pane.BufferText != legacy.Panes[i].BufferText || pane.EditorTabs != legacy.Panes[i].EditorTabs {
			t.Fatalf("archive lost after layout save: %+v", pane)
		}
	}
	if err := st.migrate(ctx); err != nil {
		t.Fatal(err)
	}
	again, err := st.LoadWorkspace(ctx, got.ID)
	if err != nil || again.Revision != reloaded.Revision {
		t.Fatal("idempotent migration changed revision", err)
	}
}

func TestImportedRetiredEditorsBecomeTerminalsWithArchivedContent(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "import.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for i, kind := range []string{"worksheet", "text-editor", ""} {
		ws := &Workspace{ID: NewID("import"), ActivePaneID: "pane", Layout: json.RawMessage(`{"panes":["pane"]}`), Panes: []Pane{{ID: NewID("pane"), Kind: kind, BufferText: "draft", EditorTabs: `{"tabs":[{"text":"draft"}]}`, Cwd: "/project"}}}
		ws.ActivePaneID = ws.Panes[0].ID
		if err := st.SaveWorkspace(ctx, ws); err != nil {
			t.Fatal(err)
		}
		loaded, err := st.LoadWorkspace(ctx, ws.ID)
		if err != nil || loaded.Panes[0].Kind != "terminal" || loaded.Panes[0].BufferText != "draft" || loaded.Panes[0].EditorTabs != ws.Panes[0].EditorTabs || loaded.ActivePaneID != ws.ActivePaneID {
			t.Fatalf("import %d lost content: %+v %v", i, loaded, err)
		}
	}
}
