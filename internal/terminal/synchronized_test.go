package terminal

import (
	"testing"
	"time"
)

func noStateWithin(t *testing.T, a *Attachment, wait time.Duration) {
	t.Helper()
	select {
	case frame := <-a.Events:
		t.Fatalf("unexpected state event %d", frame[0])
	case <-time.After(wait):
	}
}

func TestUnendedRedrawIsEndedForEveryCoreAfterTheTimeout(t *testing.T) {
	synchronizedOutputTimeout = 400 * time.Millisecond
	t.Cleanup(func() { synchronizedOutputTimeout = time.Second })
	s, pty := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol})
	defer a.Unsubscribe()

	s.publish([]byte("\x1b[?2026hframe\x1b[?2026l"))
	if nextState(t, a)[0] != StateOutput {
		t.Fatal("output missing")
	}
	noStateWithin(t, a, 600*time.Millisecond)

	s.publish([]byte("\x1b[?2026hhalf a frame"))
	if nextState(t, a)[0] != StateOutput {
		t.Fatal("output missing")
	}
	time.Sleep(150 * time.Millisecond)
	s.publish([]byte("\x1b[?2026h"))
	if nextState(t, a)[0] != StateOutput {
		t.Fatal("output missing")
	}
	// The first start's timer would have fired by now.
	noStateWithin(t, a, 350*time.Millisecond)
	if frame := nextState(t, a); frame[0] != StateSynchronizedOutputEnd || len(frame) != StateFrameHeader {
		t.Fatalf("end event = %v", frame)
	}
	s.publish([]byte("\x1b[?2026$p"))
	if pty.String() != "\x1b[?2026;2$y" {
		t.Fatalf("mode after the timeout = %q", pty.String())
	}
	if nextState(t, a)[0] != StateOutput {
		t.Fatal("output missing")
	}
	noStateWithin(t, a, 250*time.Millisecond)
}

func TestRedrawTimerStopsWithTheSession(t *testing.T) {
	synchronizedOutputTimeout = 50 * time.Millisecond
	t.Cleanup(func() { synchronizedOutputTimeout = time.Second })
	s, _ := stateSession(t)
	s.publish([]byte("\x1b[?2026h"))
	s.Close()
	time.Sleep(120 * time.Millisecond)
	s.mu.Lock()
	sequence := s.sequence
	s.mu.Unlock()
	if sequence != 1 {
		t.Fatalf("published after close: sequence %d", sequence)
	}
}
