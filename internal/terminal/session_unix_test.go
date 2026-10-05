//go:build !windows

package terminal

import (
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"testing"
	"time"
)

func TestTerminalEnvironmentReplacesTERM(t *testing.T) {
	environment := terminalEnvironment([]string{"PATH=/bin", "TERM=old", "USER=test"}, "xterm-ghostty")
	if !slices.Contains(environment, "TERM=xterm-ghostty") {
		t.Fatalf("terminal environment = %q", environment)
	}
	if slices.Contains(environment, "TERM=old") {
		t.Fatalf("terminal environment retained old TERM: %q", environment)
	}
}

func TestUnixTerminalExitReportsProcessStatus(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real local PTY")
	}
	t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	for _, code := range []int{0, 7} {
		t.Run(fmt.Sprintf("exit-%d", code), func(t *testing.T) {
			manager := NewManager()
			t.Cleanup(manager.Close)
			managed, attachment, err := manager.Attach("default", "exit-test", t.TempDir(), "xterm-256color", 80, 24,
				Cursor{OutputPaused: true})
			if err != nil {
				t.Fatal(err)
			}
			defer attachment.Unsubscribe()
			if _, err := managed.Write([]byte(fmt.Sprintf("exit %d\r", code))); err != nil {
				t.Fatal(err)
			}
			select {
			case _, open := <-attachment.Events:
				if open {
					t.Fatal("paused terminal received output instead of ending")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("shell exit did not close the paused attachment")
			}
			exited, err := managed.Exited()
			if !exited {
				t.Fatal("shell was not reported as exited")
			}
			if code == 0 {
				if err != nil {
					t.Fatalf("clean exit reported as failure: %v", err)
				}
			} else {
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != code {
					t.Fatalf("exit error = %v, want process status %d", err, code)
				}
			}
		})
	}
}
