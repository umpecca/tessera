package terminal

import (
	"testing"
	"time"
)

func TestProgressReachesPausedBrowsersLatestOnly(t *testing.T) {
	s, _ := stateSession(t)
	paused := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer paused.Unsubscribe()
	if s.CurrentProgress() != nil {
		t.Fatal("progress before any report")
	}
	s.publish([]byte("\x1b]9;4;1;10\x07"))
	s.publish([]byte("\x1b]9;4;1;20\x07\x1b]9;4;3\x07"))
	select {
	case <-paused.AlertWake:
	default:
		t.Fatal("a paused browser was not woken")
	}
	progress, ok := paused.ReadProgress()
	if !ok || progress.Type != "terminal-progress" || progress.Epoch != "test-shell" || progress.State != "indeterminate" || progress.Percent != -1 {
		t.Fatalf("progress = %+v", progress)
	}
	if _, ok := paused.ReadProgress(); ok {
		t.Fatal("older reports were queued")
	}
	if current := s.CurrentProgress(); current == nil || current.State != "indeterminate" {
		t.Fatalf("current = %+v", current)
	}
	s.publish([]byte("plain output"))
	if _, ok := paused.ReadProgress(); ok {
		t.Fatal("output without a report sent progress")
	}

	s.publish([]byte("\x1b]9;4;2;75\x07"))
	if progress, _ := paused.ReadProgress(); progress.State != "error" || progress.Percent != 75 {
		t.Fatalf("error report = %+v", progress)
	}
	s.mu.Lock()
	s.progress.at = time.Now().Add(-progressLifetime)
	s.mu.Unlock()
	if s.CurrentProgress() != nil {
		t.Fatal("a report older than its lifetime is still current")
	}
	s.publish([]byte("\x1b]9;4;0\x07"))
	if progress, _ := paused.ReadProgress(); progress.State != "remove" {
		t.Fatalf("remove = %+v", progress)
	}
	if s.CurrentProgress() != nil {
		t.Fatal("removed progress is current")
	}
}

func TestModeAndVersionQueriesReachTheShell(t *testing.T) {
	s, pty := stateSession(t)
	s.publish([]byte("\x1b[?2004$p\x1b[>q"))
	if pty.String() != "\x1b[?2004;2$y\x1bP>|Tessera dev\x1b\\" {
		t.Fatalf("replies = %q", pty.String())
	}
}

func TestCapabilityQueriesAndSizeReportsReachTheShell(t *testing.T) {
	s, pty := stateSession(t)
	if err := s.core.SetTermName("xterm-256color"); err != nil {
		t.Fatal(err)
	}
	s.publish([]byte("\x1bP+q544E;5463\x1b\\\x1bP$qr\x1b\\"))
	want := "\x1bP1+r544E=787465726D2D323536636F6C6F72\x1b\\\x1bP1+r5463\x1b\\\x1bP1$r1;24r\x1b\\"
	if pty.String() != want {
		t.Fatalf("query replies = %q", pty.String())
	}
	s.publish([]byte("\x1b[?2048h"))
	if err := s.ResizeWithMetrics(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	if err := s.ResizeWithMetrics(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	want += "\x1b[48;24;80;384;640t\x1b[48;30;100;540;900t"
	if pty.String() != want {
		t.Fatalf("size reports = %q", pty.String())
	}
}
