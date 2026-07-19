//go:build darwin || freebsd || linux || openbsd

package shell

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunnerCancellationTerminatesChildProcesses(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	events := (&Runner{}).Run(ctx, RunRequest{
		RunID:   "run-cancel-test",
		Command: "printf 'ready\\n'\nsleep 10",
		Cwd:     t.TempDir(),
	})

	readyDeadline := time.After(2 * time.Second)
	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("runner exited before starting child process")
			}
			if event.Type == "stdout" && strings.Contains(event.Text, "ready") {
				cancel()
				goto waitForExit
			}
		case <-readyDeadline:
			cancel()
			t.Fatal("child process did not start before deadline")
		}
	}

waitForExit:
	exitDeadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-events:
			if !ok {
				return
			}
		case <-exitDeadline:
			t.Fatal("runner did not stop promptly after cancellation")
		}
	}
}
