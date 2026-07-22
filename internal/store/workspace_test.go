package store

import (
	"context"
	"encoding/json"
	"errors"
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
		ID:             "pane-first",
		Title:          "First",
		BufferText:     "pwd\noutput\n",
		EditorMode:     "normal",
		FontSize:       18,
		Cwd:            defaultCwd,
		LastExportPath: filepath.Join(defaultCwd, "first.txt"),
		EditorTabs:     `{"active":0,"tabs":[{"path":"first.txt","text":"pwd\noutput\n"}]}`,
		BrowserURL:     "http://localhost:5000/",
		Minimized:      true,
		X:              11,
		Y:              22,
		Width:          333,
		Height:         222,
		ZIndex:         4,
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
	ws.BackgroundMode = "fit"
	ws.DefaultPaneFontSize = 18
	ws.DefaultTheme = "studio"
	ws.ThemeID = "hacker"
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
	if loaded.BackgroundMode != "fit" {
		t.Fatalf("background mode = %q, want fit", loaded.BackgroundMode)
	}
	if loaded.DefaultPaneFontSize != 18 || loaded.DefaultTheme != "studio" || loaded.ThemeID != "hacker" {
		t.Fatalf("workspace settings were not persisted: %+v", loaded)
	}
	if len(loaded.Panes) != 2 {
		t.Fatalf("pane count = %d, want 2", len(loaded.Panes))
	}
	if loaded.Panes[0].BufferText != "pwd\noutput\n" {
		t.Fatalf("first pane buffer was not persisted: %q", loaded.Panes[0].BufferText)
	}
	if loaded.Panes[0].LastExportPath != filepath.Join(defaultCwd, "first.txt") {
		t.Fatalf("first pane last export path = %q", loaded.Panes[0].LastExportPath)
	}
	if loaded.Panes[0].EditorTabs == "" {
		t.Fatal("first pane editor tabs were not persisted")
	}
	if loaded.Panes[0].BrowserURL != "http://localhost:5000/" {
		t.Fatalf("first pane browser URL = %q", loaded.Panes[0].BrowserURL)
	}
	if loaded.Panes[0].EditorMode != "normal" {
		t.Fatalf("first pane editor mode = %q, want normal", loaded.Panes[0].EditorMode)
	}
	if loaded.Panes[0].FontSize != 18 {
		t.Fatalf("first pane font size = %d, want 18", loaded.Panes[0].FontSize)
	}
	if !loaded.Panes[0].Minimized {
		t.Fatal("first pane minimized state was not persisted")
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

func TestWorkspaceRevisionRejectsStaleSaveAndStaysScoped(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	if _, err := st.LoadDefaultWorkspace(ctx, ""); err != nil {
		t.Fatalf("create default workspace: %v", err)
	}
	firstClient, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load first client: %v", err)
	}
	staleClient, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load stale client: %v", err)
	}
	if firstClient.Revision == "" || staleClient.Revision != firstClient.Revision {
		t.Fatalf("initial revisions = %q and %q", firstClient.Revision, staleClient.Revision)
	}

	firstClient.Panes = []Pane{{ID: "pane-new", Title: "New state", Width: 320, Height: 200}}
	firstClient.Layout = json.RawMessage(`{"panes":["pane-new"]}`)
	initialRevision := firstClient.Revision
	if err := st.SaveWorkspace(ctx, firstClient); err != nil {
		t.Fatalf("save first client: %v", err)
	}
	if firstClient.Revision == initialRevision {
		t.Fatal("successful save did not advance revision")
	}

	staleClient.Panes = []Pane{{ID: "pane-stale", Title: "Stale state", Width: 320, Height: 200}}
	staleClient.Layout = json.RawMessage(`{"panes":["pane-stale"]}`)
	if err := st.SaveWorkspace(ctx, staleClient); !errors.Is(err, ErrWorkspaceConflict) {
		t.Fatalf("stale save error = %v, want workspace conflict", err)
	}
	loaded, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("reload winning workspace: %v", err)
	}
	if len(loaded.Panes) != 1 || loaded.Panes[0].ID != "pane-new" || loaded.Revision != firstClient.Revision {
		t.Fatalf("stale save changed winning workspace: %+v", loaded)
	}

	independent := &Workspace{ID: "other", Name: "Other", Layout: json.RawMessage(`{"panes":[]}`)}
	if err := st.SaveWorkspace(ctx, independent); err != nil {
		t.Fatalf("create independent workspace: %v", err)
	}
	independentRevision := independent.Revision
	loaded.ActivePaneID = "pane-new"
	if err := st.SaveWorkspace(ctx, loaded); err != nil {
		t.Fatalf("save default workspace again: %v", err)
	}
	independentReloaded, err := st.LoadWorkspace(ctx, "other")
	if err != nil {
		t.Fatalf("reload independent workspace: %v", err)
	}
	if independentReloaded.Revision != independentRevision {
		t.Fatalf("independent revision changed from %q to %q", independentRevision, independentReloaded.Revision)
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
		Revision:     ws.Revision,
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

func TestAllMinimizedPanesDoNotBecomeActive(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	ws := &Workspace{
		ID:   DefaultWorkspaceID,
		Name: "Default",
		Panes: []Pane{{
			ID:        "pane-hidden",
			Title:     "Hidden",
			Minimized: true,
			Width:     320,
			Height:    200,
		}},
	}
	if err := st.SaveWorkspace(ctx, ws); err != nil {
		t.Fatalf("save workspace: %v", err)
	}
	loaded, err := st.LoadWorkspace(ctx, DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if loaded.ActivePaneID != "" {
		t.Fatalf("active pane = %q, want none when every pane is minimized", loaded.ActivePaneID)
	}
}
