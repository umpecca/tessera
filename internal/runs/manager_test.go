package runs

import (
	"context"
	"encoding/json"
	"os"
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
	databasePath := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	const readyText = "run-ready\n"
	const outputText = "persisted-after-unsubscribe\n"
	// Gate output so subscriber removal happens after actual shell startup
	// and before the output being checked, independent of scheduling delays.
	command := "printf 'run-ready\\n'\nwhile [ ! -f release-output ]; do sleep 0.05; done\nprintf 'persisted-after-unsubscribe\\n'"
	if runtime.GOOS == "windows" {
		command = "[Console]::WriteLine('run-ready')\nwhile (-not [System.IO.File]::Exists('release-output')) { [System.Threading.Thread]::Sleep(10) }\n[Console]::WriteLine('persisted-after-unsubscribe')"
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
	defer func() {
		cleanup, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := manager.Shutdown(cleanup); err != nil {
			t.Errorf("clean up run: %v", err)
		}
	}()

	events, unsubscribe, runID, err := manager.Start(StartRequest{
		WorkspaceID: store.DefaultWorkspaceID,
		PaneID:      "pane-test",
		Command:     command,
		Cwd:         workspace.Panes[0].Cwd,
		InsertPos:   len(command),
	})
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	defer unsubscribe()
	manager.mu.Lock()
	run := manager.runs[runID]
	manager.mu.Unlock()
	if run == nil {
		t.Fatalf("run %s was not registered", runID)
	}
	// Cold PowerShell startup on a shared Windows worker is separate from
	// command completion. The ready marker comes from the actual process.
	readyDeadline := time.NewTimer(60 * time.Second)
	defer readyDeadline.Stop()
	var observed strings.Builder
	for !strings.Contains(observed.String(), readyText) {
		select {
		case event, open := <-events:
			if !open {
				t.Fatal("command exited before readiness")
			}
			if event.Type == "error" {
				t.Fatalf("command startup failed: %s", event.Error)
			}
			if event.Type == "insert" {
				observed.WriteString(event.Text)
			}
		case <-readyDeadline.C:
			t.Fatalf("run %s did not produce readiness output within 60 seconds; transcript=%q", runID, run.buffer())
		}
	}
	if strings.Contains(observed.String(), outputText) {
		t.Fatal("command produced its gated output before unsubscribe")
	}
	unsubscribe()
	if err := os.WriteFile(filepath.Join(workspace.Panes[0].Cwd, "release-output"), []byte("release"), 0o600); err != nil {
		t.Fatalf("release command output: %v", err)
	}

	select {
	case <-run.done:
	case <-time.After(20 * time.Second):
		t.Fatalf("run %s was still active 20 seconds after releasing output; transcript=%q", runID, run.buffer())
	}
	if len(manager.ActiveRuns(store.DefaultWorkspaceID)) != 0 {
		t.Fatalf("run %s completed but remained active", runID)
	}

	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}
	reopened, err := store.Open(ctx, databasePath)
	if err != nil {
		t.Fatalf("reopen store: %v", err)
	}
	defer reopened.Close()
	loaded, err := reopened.LoadWorkspace(ctx, store.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if len(loaded.Panes) != 1 {
		t.Fatalf("pane count = %d, want 1", len(loaded.Panes))
	}
	buffer := loaded.Panes[0].BufferText
	if want := command + "\n" + readyText + outputText; buffer != want {
		t.Fatalf("persisted buffer = %q, want %q", buffer, want)
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
