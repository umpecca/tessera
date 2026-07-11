package runs

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"tessera/internal/shell"
	"tessera/internal/store"
)

func TestManagerPersistsOutputAfterSubscriberLeaves(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	command := "sleep 1\nprintf 'done\\n'"
	if runtime.GOOS == "windows" {
		command = "Start-Sleep -Milliseconds 400\nWrite-Output done"
	}

	workspace := &store.Workspace{
		ID:           store.DefaultWorkspaceID,
		Name:         "Default",
		ActivePaneID: "pane-test",
		Layout:       json.RawMessage(`{"panes":["pane-test"]}`),
		Panes: []store.Pane{{
			ID:         "pane-test",
			Title:      "Test",
			BufferText: command,
			Cwd:        t.TempDir(),
			X:          10,
			Y:          20,
			Width:      320,
			Height:     200,
			ZIndex:     1,
		}},
	}
	if err := st.SaveWorkspace(ctx, workspace); err != nil {
		t.Fatalf("save workspace: %v", err)
	}

	manager := NewManager(st, &shell.Runner{})
	defer manager.Close()

	_, unsubscribe, runID, err := manager.Start(StartRequest{
		WorkspaceID: store.DefaultWorkspaceID,
		PaneID:      "pane-test",
		Command:     command,
		Cwd:         workspace.Panes[0].Cwd,
		InsertPos:   len(command),
	})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	unsubscribe()

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if len(manager.ActiveRuns(store.DefaultWorkspaceID)) == 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(manager.ActiveRuns(store.DefaultWorkspaceID)) != 0 {
		t.Fatalf("run %s was still active after deadline", runID)
	}

	loaded, err := st.LoadWorkspace(ctx, store.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if len(loaded.Panes) != 1 {
		t.Fatalf("pane count = %d, want 1", len(loaded.Panes))
	}
	buffer := loaded.Panes[0].BufferText
	if !strings.Contains(buffer, command+"\n") {
		t.Fatalf("buffer missing command/output separator: %q", buffer)
	}
	if !strings.Contains(buffer, "done") {
		t.Fatalf("buffer = %q, want command output", buffer)
	}
}

func TestStopWorkspaceDoesNotCancelOtherWorkspace(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	command := "sleep 5"
	if runtime.GOOS == "windows" {
		command = "Start-Sleep -Seconds 5"
	}
	for _, workspaceID := range []string{"one", "two"} {
		workspace := &store.Workspace{
			ID: workspaceID, OwnerID: "alice", Name: workspaceID,
			Layout: json.RawMessage(`{"panes":["pane-` + workspaceID + `"]}`),
			Panes:  []store.Pane{{ID: "pane-" + workspaceID, Title: workspaceID, BufferText: command, Cwd: t.TempDir(), Width: 320, Height: 200}},
		}
		if err := st.SaveWorkspace(ctx, workspace); err != nil {
			t.Fatalf("save workspace %s: %v", workspaceID, err)
		}
	}

	manager := NewManager(st, &shell.Runner{})
	defer manager.Close()
	for _, workspaceID := range []string{"one", "two"} {
		_, unsubscribe, _, err := manager.Start(StartRequest{
			WorkspaceID: workspaceID, PaneID: "pane-" + workspaceID, Command: command, Cwd: t.TempDir(), InsertPos: len(command),
		})
		if err != nil {
			t.Fatalf("start workspace %s: %v", workspaceID, err)
		}
		unsubscribe()
	}

	stopCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	if err := manager.StopWorkspace(stopCtx, "one"); err != nil {
		t.Fatalf("stop workspace one: %v", err)
	}
	if got := len(manager.ActiveRuns("one")); got != 0 {
		t.Fatalf("workspace one active runs = %d", got)
	}
	if got := len(manager.ActiveRuns("two")); got != 1 {
		t.Fatalf("workspace two active runs = %d, want 1", got)
	}
	if err := manager.StopWorkspace(stopCtx, "two"); err != nil {
		t.Fatalf("stop workspace two: %v", err)
	}
}
