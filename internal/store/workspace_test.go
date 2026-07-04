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

func TestPreservePaneBuffersKeepsRunningPaneTranscript(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	ws := &Workspace{
		ID:           DefaultWorkspaceID,
		Name:         "Default",
		ActivePaneID: "pane-running",
		Layout:       json.RawMessage(`{"panes":["pane-running","pane-other"]}`),
		Panes: []Pane{{
			ID:         "pane-running",
			Title:      "Running",
			BufferText: "sleep 10\nold",
			Cwd:        t.TempDir(),
			Width:      320,
			Height:     200,
		}, {
			ID:         "pane-other",
			Title:      "Other",
			BufferText: "notes",
			Cwd:        t.TempDir(),
			Width:      320,
			Height:     200,
		}},
	}
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatalf("save workspace: %v", err)
	}
	if err := st.UpdatePaneBufferAndCwd(ctx, DefaultWorkspaceID, "pane-running", "sleep 10\nnew output\n", "new-cwd"); err != nil {
		t.Fatalf("update running pane: %v", err)
	}

	incoming := &Workspace{
		ID:           DefaultWorkspaceID,
		Name:         "Default",
		ActivePaneID: "pane-other",
		Layout:       ws.Layout,
		Panes: []Pane{{
			ID:         "pane-running",
			Title:      "Running renamed",
			BufferText: "sleep 10\nstale browser copy",
			Cwd:        "stale-cwd",
			Width:      500,
			Height:     240,
		}, {
			ID:         "pane-other",
			Title:      "Other",
			BufferText: "edited notes",
			Cwd:        ws.Panes[1].Cwd,
			Width:      320,
			Height:     200,
		}},
	}
	if err := st.PreservePaneBuffers(ctx, incoming, map[string]bool{"pane-running": true}); err != nil {
		t.Fatalf("preserve pane buffers: %v", err)
	}
	if err := st.SaveWorkspace(ctx, incoming); err != nil {
		t.Fatalf("save preserved workspace: %v", err)
	}

	loaded, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	var running Pane
	for _, pane := range loaded.Panes {
		if pane.ID == "pane-running" {
			running = pane
		}
	}
	if running.BufferText != "sleep 10\nnew output\n" {
		t.Fatalf("running buffer = %q, want host transcript", running.BufferText)
	}
	if running.Cwd != "new-cwd" {
		t.Fatalf("running cwd = %q, want new-cwd", running.Cwd)
	}
	if running.Title != "Running renamed" || running.Width != 500 {
		t.Fatalf("non-transcript pane fields were not saved: %+v", running)
	}
}
