//go:build !windows

package terminal

import (
	"slices"
	"testing"
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
