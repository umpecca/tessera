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
	manager.mu.Lock()
	run := manager.runs[runID]
	manager.mu.Unlock()
	if run == nil {
		t.Fatalf("run %s was not registered", runID)
	}
	unsubscribe()

	select {
	case <-run.done:
	case <-time.After(20 * time.Second):
		t.Fatalf("run %s was still active after deadline", runID)
	}
	if len(manager.ActiveRuns(store.DefaultWorkspaceID)) != 0 {
		t.Fatalf("run %s completed but remained active", runID)
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

func TestShutdownWaitsForAllWorkspaceCommands(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	m := NewManager(st, &shell.Runner{})
	defer m.Close()
	// Start the child before reporting readiness. Otherwise shutdown can race
	// with the shell's fork on macOS and miss a child that keeps output pipes open.
	command := "sleep 30 &\nchild=$!\nprintf 'ready\\n'\nwait \"$child\""
	if runtime.GOOS == "windows" {
		command = "Write-Output ready; Start-Sleep -Seconds 30"
	}
	for _, id := range []string{"one", "two"} {
		if err := st.SaveWorkspace(ctx, &store.Workspace{
			ID: id, OwnerID: "default", Name: id, Layout: json.RawMessage(`{}`),
			Panes: []store.Pane{{ID: "pane-" + id, Title: "Run", Cwd: t.TempDir(), Width: 320, Height: 200}},
		}); err != nil {
			t.Fatal(err)
		}
		events, unsubscribe, _, err := m.Start(StartRequest{WorkspaceID: id, PaneID: "pane-" + id, Command: command})
		if err != nil {
			t.Fatal(err)
		}
		defer unsubscribe()
		// Observe output from the actual process, not just registration, before
		// asserting that shutdown cancels and reaps the running command.
		ready, cancelReady := context.WithTimeout(ctx, 10*time.Second)
		var output strings.Builder
		for !strings.Contains(output.String(), "ready") {
			select {
			case event, open := <-events:
				if !open {
					cancelReady()
					t.Fatal("command exited before readiness")
				}
				if event.Type == "insert" {
					output.WriteString(event.Text)
				}
			case <-ready.Done():
				cancelReady()
				t.Fatal("command did not start")
			}
		}
		cancelReady()
	}
	deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := m.Shutdown(deadline); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two"} {
		if len(m.ActiveRuns(id)) != 0 {
			t.Fatalf("workspace %s still has a running command", id)
		}
	}
}

func TestStopWorkspaceDoesNotCancelOtherWorkspace(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, ":memory:")
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
