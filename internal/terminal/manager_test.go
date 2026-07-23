package terminal

import (
	"bytes"
	"io"
	"testing"
)

type pidTestPTY struct{ pid int }

func (p *pidTestPTY) Read([]byte) (int, error)       { return 0, io.EOF }
func (p *pidTestPTY) Write(data []byte) (int, error) { return len(data), nil }
func (p *pidTestPTY) Resize(int, int) error          { return nil }
func (p *pidTestPTY) Close() error                   { return nil }
func (p *pidTestPTY) PID() int                       { return p.pid }
func (p *pidTestPTY) Wait() error                    { return nil }

type writeTestPTY struct{ bytes.Buffer }

func (p *writeTestPTY) Read([]byte) (int, error) { return 0, io.EOF }
func (p *writeTestPTY) Resize(int, int) error    { return nil }
func (p *writeTestPTY) Close() error             { return nil }
func (p *writeTestPTY) PID() int                 { return 1 }
func (p *writeTestPTY) Wait() error              { return nil }

func TestManagedSessionScrollbackReplayAndSubscribe(t *testing.T) {
	session := &ManagedSession{
		subscribers: map[chan []byte]struct{}{},
		scrollback:  scrollbackBuffer{limit: 5},
	}

	session.publish([]byte("hello"))
	session.publish([]byte(" world"))

	replay, events, unsubscribe := session.subscribe()
	defer unsubscribe()

	if string(replay) != "world" {
		t.Fatalf("replay = %q, want %q", string(replay), "world")
	}

	session.publish([]byte("!"))
	select {
	case chunk := <-events:
		if string(chunk) != "!" {
			t.Fatalf("event chunk = %q, want %q", string(chunk), "!")
		}
	default:
		t.Fatal("expected live terminal chunk")
	}
}

func TestManagedSessionFinishClosesSubscribers(t *testing.T) {
	session := &ManagedSession{
		subscribers: map[chan []byte]struct{}{},
		scrollback:  scrollbackBuffer{limit: defaultScrollbackLimit},
	}

	_, events, unsubscribe := session.subscribe()
	defer unsubscribe()

	session.finish()
	if _, ok := <-events; ok {
		t.Fatal("subscriber channel is still open after finish")
	}
}

func TestTerminateWorkspaceOnlyClosesMatchingSessions(t *testing.T) {
	manager := NewManager()
	one := &ManagedSession{manager: manager, workspaceID: "one", paneID: "pane", subscribers: map[chan []byte]struct{}{}}
	two := &ManagedSession{manager: manager, workspaceID: "two", paneID: "pane", subscribers: map[chan []byte]struct{}{}}
	manager.sessions[sessionKey("one", "pane")] = one
	manager.sessions[sessionKey("two", "pane")] = two

	manager.TerminateWorkspace("one")
	if !one.isClosed() {
		t.Fatal("matching session was not closed")
	}
	if two.isClosed() {
		t.Fatal("other workspace session was closed")
	}
}

func TestProcessIDAndCloseHandlerFollowLivePane(t *testing.T) {
	manager := NewManager()
	managed := &ManagedSession{
		manager: manager, workspaceID: "workspace", paneID: "pane",
		session:     &Session{pty: &pidTestPTY{pid: 4242}},
		subscribers: map[chan []byte]struct{}{},
	}
	manager.sessions[sessionKey("workspace", "pane")] = managed
	closed := make(chan string, 1)
	manager.SetCloseHandler(func(workspaceID, paneID string) { closed <- workspaceID + "/" + paneID })
	if pid, ok := manager.ProcessID("workspace", "pane"); !ok || pid != 4242 {
		t.Fatalf("ProcessID = (%d, %v), want (4242, true)", pid, ok)
	}
	managed.finish()
	if _, ok := manager.ProcessID("workspace", "pane"); ok {
		t.Fatal("closed pane still exposes a PID")
	}
	select {
	case got := <-closed:
		if got != "workspace/pane" {
			t.Fatalf("close callback = %q", got)
		}
	default:
		t.Fatal("close callback was not invoked")
	}
}

func TestManagedSessionGatesTaggedMouseInputFromPTYModes(t *testing.T) {
	pty := &writeTestPTY{}
	managed := &ManagedSession{
		session:     &Session{pty: pty},
		subscribers: map[chan []byte]struct{}{},
	}
	mouse := []byte("\x1b[<32;53;17M")

	if n, err := managed.WriteMouse(mouse); err != nil || n != len(mouse) {
		t.Fatalf("disabled WriteMouse = (%d, %v), want (%d, nil)", n, err, len(mouse))
	}
	if pty.Len() != 0 {
		t.Fatalf("disabled mouse input reached PTY: %q", pty.String())
	}

	managed.publish([]byte("\x1b[?10"))
	managed.publish([]byte("02;1006h"))
	if _, err := managed.WriteMouse(mouse); err != nil {
		t.Fatalf("enabled WriteMouse: %v", err)
	}
	if got := pty.String(); got != string(mouse) {
		t.Fatalf("enabled mouse input = %q, want %q", got, mouse)
	}

	managed.publish([]byte("\x1b[?1002"))
	managed.publish([]byte("l"))
	if _, err := managed.WriteMouse(mouse); err != nil {
		t.Fatalf("disabled WriteMouse after reset: %v", err)
	}
	if got := pty.String(); got != string(mouse) {
		t.Fatalf("stale mouse input reached PTY: %q", got)
	}

	keyboard := []byte("echo still works\r")
	if _, err := managed.Write(keyboard); err != nil {
		t.Fatalf("ordinary Write: %v", err)
	}
	if got, want := pty.String(), string(mouse)+string(keyboard); got != want {
		t.Fatalf("PTY input = %q, want %q", got, want)
	}
}

func TestMouseModeTrackerKeepsOtherTrackingModesEnabled(t *testing.T) {
	var tracker mouseModeTracker
	tracker.consume([]byte("\x1b[?1000;1003h"))
	tracker.consume([]byte("\x1b[?1000l"))
	if !tracker.enabled() {
		t.Fatal("disabling one DEC mode disabled another active mouse mode")
	}
	tracker.consume([]byte("\x1b[?1003l"))
	if tracker.enabled() {
		t.Fatal("mouse tracking remained enabled after every tracking mode was reset")
	}
}
