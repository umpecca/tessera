package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestDefaultWorkspaceRoundTrip(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	defaultCwd := t.TempDir()
	ws, err := st.LoadDefaultWorkspace(ctx, defaultCwd)
	if err != nil {
		t.Fatalf("load default workspace: %v", err)
	}
	if ws.ID != DefaultWorkspaceID {
		t.Fatalf("workspace id = %q, want %q", ws.ID, DefaultWorkspaceID)
	}
	if len(ws.Panes) != 0 {
		t.Fatalf("pane count = %d, want 0", len(ws.Panes))
	}

	ws.Panes = []Pane{{
		ID:         "pane-first",
		Title:      "First",
		BufferText: "pwd\noutput\n",
		Cwd:        defaultCwd,
		X:          11,
		Y:          22,
		Width:      333,
		Height:     222,
		ZIndex:     4,
	}, {
		ID:         "pane-test",
		Title:      "Second",
		BufferText: "echo ok\n",
		Cwd:        defaultCwd,
		X:          40,
		Y:          50,
		Width:      400,
		Height:     300,
		ZIndex:     8,
	}}
	ws.ActivePaneID = "pane-test"
	ws.Layout = json.RawMessage(`{"panes":["pane-first","pane-test"]}`)

	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatalf("save workspace: %v", err)
	}

	loaded, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	if loaded.ActivePaneID != "pane-test" {
		t.Fatalf("active pane = %q, want pane-test", loaded.ActivePaneID)
	}
	if len(loaded.Panes) != 2 {
		t.Fatalf("pane count = %d, want 2", len(loaded.Panes))
	}
	if loaded.Panes[0].BufferText != "pwd\noutput\n" {
		t.Fatalf("first pane buffer was not persisted: %q", loaded.Panes[0].BufferText)
	}
	if loaded.Panes[0].X != 11 || loaded.Panes[0].Y != 22 || loaded.Panes[0].Width != 333 || loaded.Panes[0].Height != 222 || loaded.Panes[0].ZIndex != 4 {
		t.Fatalf("first pane geometry was not persisted: %+v", loaded.Panes[0])
	}
	if !json.Valid(loaded.Layout) {
		t.Fatalf("layout is not valid JSON: %s", loaded.Layout)
	}

	loaded.Panes = nil
	loaded.ActivePaneID = ""
	loaded.Layout = json.RawMessage(`{"panes":[]}`)
	if err := st.SaveWorkspace(ctx, loaded); err != nil {
		t.Fatalf("save empty workspace: %v", err)
	}
	empty, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("reload empty workspace: %v", err)
	}
	if len(empty.Panes) != 0 {
		t.Fatalf("empty pane count = %d, want 0", len(empty.Panes))
	}
}
