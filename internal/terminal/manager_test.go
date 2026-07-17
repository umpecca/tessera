package terminal

import (
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

func TestManagedSessionScrollbackReplayAndSubscribe(t *testing.T) {
	session := &ManagedSession{
		subscribers:     map[chan []byte]struct{}{},
		scrollbackLimit: 5,
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
		subscribers:     map[chan []byte]struct{}{},
		scrollbackLimit: defaultScrollbackLimit,
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
