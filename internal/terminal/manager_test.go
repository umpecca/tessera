package terminal

import "testing"

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
