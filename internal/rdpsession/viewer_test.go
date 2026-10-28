package rdpsession

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordingViewer struct {
	mu       sync.Mutex
	events   []recordedEvent
	detached []string
}

func (v *recordingViewer) Event(kind uint32, payload []byte) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.events = append(v.events, recordedEvent{kind, append([]byte(nil), payload...)})
}

func (v *recordingViewer) Detached(reason string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.detached = append(v.detached, reason)
}

func (v *recordingViewer) has(kind uint32) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	for _, event := range v.events {
		if event.kind == kind {
			return true
		}
	}
	return false
}

func (r *scriptRunner) count(message []byte) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, got := range r.received {
		if bytes.Equal(got, message) {
			n++
		}
	}
	return n
}

// eventually polls until condition holds.
func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func startedSession(t *testing.T, runner *scriptRunner, idle time.Duration) (*Session, *holdServer) {
	t.Helper()
	server := startHoldServer(t)
	s := NewSession(runner, testTarget(server.address()), nil)
	s.SetIdleLimit(idle)
	if err := s.Start(context.Background(), "pw"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s, server
}

func TestAttachResumesTheDisplayAndDetachPausesIt(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	viewer := &recordingViewer{}
	detach, err := s.Attach(viewer)
	if err != nil {
		t.Fatal(err)
	}
	if !viewer.has(eventConnected) {
		t.Fatal("the viewer wasn't told the desktop size")
	}
	eventually(t, "the resume request", func() bool { return runner.count(suppressMessage(true)) == 1 })
	if !s.Post([]byte{tagRefresh}) {
		t.Fatal("an active session refused a message")
	}
	eventually(t, "an event for the viewer", func() bool { return viewer.has(eventImage) })
	detach()
	eventually(t, "the pause request", func() bool { return runner.count(suppressMessage(false)) == 1 })
	detach() // a second detach does nothing
	time.Sleep(50 * time.Millisecond)
	if runner.count(suppressMessage(false)) != 1 {
		t.Fatal("detaching twice paused twice")
	}
}

func TestANewViewerTakesOver(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, _ := startedSession(t, runner, 0)
	first, second := &recordingViewer{}, &recordingViewer{}
	detachFirst, err := s.Attach(first)
	if err != nil {
		t.Fatal(err)
	}
	detachSecond, err := s.Attach(second)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.detached) != 1 || first.detached[0] != takenOverReason {
		t.Fatalf("the first viewer was told %v", first.detached)
	}
	detachFirst() // the replaced viewer's detach must not pause the second's session
	time.Sleep(50 * time.Millisecond)
	if runner.count(suppressMessage(false)) != 0 {
		t.Fatal("a replaced viewer's detach paused the session")
	}
	detachSecond()
	eventually(t, "the pause request", func() bool { return runner.count(suppressMessage(false)) == 1 })
}

func TestAttachNeedsAnActiveSession(t *testing.T) {
	runner := &scriptRunner{cookie: true}
	s, server := startedSession(t, runner, 0)
	_ = server.next(t).Close()
	waitDone(t, s)
	if _, err := s.Attach(&recordingViewer{}); !errors.Is(err, ErrNotActive) {
		t.Fatalf("Attach to a lost session = %v, want ErrNotActive", err)
	}
}

func TestAnUnwatchedSessionEndsAtTheIdleLimit(t *testing.T) {
	s, _ := startedSession(t, &scriptRunner{cookie: true}, 60*time.Millisecond)
	waitDone(t, s)
	if info := s.Info(); info.State != StateEnded || info.Reason != idleReason {
		t.Fatalf("info = %+v", info)
	}
}

func TestAViewerKeepsTheSessionAliveUntilItDetaches(t *testing.T) {
	s, _ := startedSession(t, &scriptRunner{cookie: true}, 150*time.Millisecond)
	detach, err := s.Attach(&recordingViewer{})
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(400 * time.Millisecond)
	if s.Info().State != StateActive {
		t.Fatalf("the session ended while watched: %+v", s.Info())
	}
	detach()
	waitDone(t, s)
	if info := s.Info(); info.State != StateEnded || !strings.Contains(info.Reason, "idle limit") {
		t.Fatalf("info = %+v", info)
	}
}

func TestALostSessionEndsAtTheIdleLimit(t *testing.T) {
	s, server := startedSession(t, &scriptRunner{cookie: true}, 400*time.Millisecond)
	_ = server.next(t).Close()
	waitDone(t, s)
	if s.Info().State != StateLost {
		t.Fatalf("state = %v, want lost", s.Info().State)
	}
	eventually(t, "the lost session to end", func() bool { return s.Info().State == StateEnded })
	if info := s.Info(); info.Reason != idleReason || info.CanRejoin {
		t.Fatalf("info = %+v", info)
	}
}
