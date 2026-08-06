package httpapi

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestTerminalCloseReasonCarriesTheFailure(t *testing.T) {
	got := terminalCloseReason("terminal failed", errors.New("fork/exec /bin/zsh: no such file"))
	if want := "terminal failed: fork/exec /bin/zsh: no such file"; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
}

func TestTerminalCloseReasonDescribesAnUnnamedFailure(t *testing.T) {
	if got, want := terminalCloseReason("terminal failed", nil), "terminal failed"; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
	if got, want := terminalCloseReason("terminal failed", errors.New("")), "terminal failed"; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
}

// A shell that ended cleanly has nothing to add, so the summary stands alone.
func TestTerminalCloseReasonReportsAnExitWithAndWithoutAnError(t *testing.T) {
	if got, want := terminalCloseReason("terminal exited", nil), "terminal exited"; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
	got := terminalCloseReason("terminal exited", errors.New("read /dev/ptmx: input/output error"))
	if want := "terminal exited: read /dev/ptmx: input/output error"; got != want {
		t.Fatalf("reason = %q, want %q", got, want)
	}
}

func TestTerminalCloseReasonFitsTheCloseFrame(t *testing.T) {
	got := terminalCloseReason("terminal failed", errors.New(strings.Repeat("x", 500)))
	if len(got) != maxTerminalCloseReason {
		t.Fatalf("length = %d, want %d", len(got), maxTerminalCloseReason)
	}
	if !strings.HasPrefix(got, "terminal failed: ") {
		t.Fatalf("reason = %q, want the failure prefix kept", got)
	}
}

// A reason cut at the byte limit could split a rune, which the close frame
// is not allowed to carry.
func TestTerminalCloseReasonTrimsToARuneBoundary(t *testing.T) {
	got := terminalCloseReason("terminal failed", errors.New(strings.Repeat("é", 200)))
	if len(got) > maxTerminalCloseReason {
		t.Fatalf("length = %d, want at most %d", len(got), maxTerminalCloseReason)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("reason = %q, want valid UTF-8", got)
	}
}
