package shell

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestRunnerStreamsOutputAndTracksCwd(t *testing.T) {
	parent := t.TempDir()
	child := filepath.Join(parent, "child")
	if err := os.Mkdir(child, 0o755); err != nil {
		t.Fatalf("create child dir: %v", err)
	}

	command := "printf 'hello\\n'\ncd .."
	if runtime.GOOS == "windows" {
		command = "Write-Output hello\nSet-Location .."
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var stdout strings.Builder
	var finalCwd string
	exitCode := -1
	runner := &Runner{}
	for event := range runner.Run(ctx, RunRequest{
		RunID:   "run-test",
		Command: command,
		Cwd:     child,
	}) {
		if event.Type == "stdout" {
			stdout.WriteString(event.Text)
		}
		if event.Type == "exit" {
			finalCwd = event.Cwd
			if event.Code != nil {
				exitCode = *event.Code
			}
		}
	}

	if !strings.Contains(stdout.String(), "hello") {
		t.Fatalf("stdout = %q, want hello", stdout.String())
	}
	if exitCode != 0 {
		t.Fatalf("exit code = %d, want 0", exitCode)
	}
	if !samePath(finalCwd, parent) {
		t.Fatalf("final cwd = %q, want %q", finalCwd, parent)
	}
}

func TestRunnerEmitsOutputBeforeCommandExit(t *testing.T) {
	command := "printf 'first\\n'\nsleep 2\nprintf 'second\\n'"
	if runtime.GOOS == "windows" {
		command = "Write-Output first\nStart-Sleep -Seconds 2\nWrite-Output second"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	runner := &Runner{}
	events := runner.Run(ctx, RunRequest{
		RunID:   "run-stream-test",
		Command: command,
		Cwd:     t.TempDir(),
	})

	deadline := time.After(1500 * time.Millisecond)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("runner exited before streaming first output")
			}
			if event.Type == "exit" {
				t.Fatal("runner exited before streaming first output")
			}
			if event.Type == "stdout" && strings.Contains(event.Text, "first") {
				for range events {
				}
				return
			}
		case <-deadline:
			t.Fatal("first output did not stream before the command finished sleeping")
		}
	}
}

func samePath(a, b string) bool {
	aInfo, aErr := os.Stat(a)
	bInfo, bErr := os.Stat(b)
	if aErr == nil && bErr == nil {
		return os.SameFile(aInfo, bInfo)
	}
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
