package terminal

import (
	"strings"
	"tessera/internal/terminalcore"
	"tessera/internal/terminalfile"
	"testing"
	"time"
)

func takeFile(t *testing.T, a *Attachment) terminalfile.Event {
	t.Helper()
	select {
	case <-a.FileWake:
	case <-time.After(time.Second):
		t.Fatal("missing live file event")
	}
	event, ok := a.ReadFile()
	if !ok {
		t.Fatal("empty file event")
	}
	return event
}
func TestFileLiveHiddenSubscribersAndNoReplay(t *testing.T) {
	s, pty := stateSession(t)
	s.manager = NewManager()
	t.Cleanup(func() { s.closed.Store(true); s.manager.Close() })
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	b := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer b.Unsubscribe()
	a.EnableFiles("a")
	b.EnableFiles("b")
	sequence, _ := terminalfile.Serialize(terminalfile.Command{Action: "upload", ID: "id", Directory: t.TempDir()})
	s.publish([]byte(sequence))
	for _, listener := range []*Attachment{a, b} {
		event := takeFile(t, listener)
		if event.Action != "request" || event.ID != "id" {
			t.Fatal(event)
		}
		select {
		case <-listener.Events:
			t.Fatal("hidden text resumed")
		default:
		}
	}
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch, Sequence: s.sequence, Offset: s.published}
	reconnect := s.subscribe(cursor)
	defer reconnect.Unsubscribe()
	reconnect.EnableFiles("late")
	if _, ok := reconnect.ReadFile(); ok {
		t.Fatal("historical invitation replayed")
	}
	s.publish([]byte(terminalfile.Prefix + "query;nonce\a"))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if _, ok := terminalfile.MatchReply([]byte(pty.String()), "capabilities", "nonce"); ok {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("host did not answer query")
}
func TestFileQueueOverflowLeavesTextAndShellAlone(t *testing.T) {
	s, _ := stateSession(t)
	s.manager = NewManager()
	t.Cleanup(s.manager.Close)
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	a.EnableFiles("a")
	var sub *subscriber
	s.mu.Lock()
	for candidate := range s.subscribers {
		sub = candidate
	}
	s.mu.Unlock()
	for range 9 {
		s.enqueueFile(sub, terminalfile.Event{Type: "terminal-file", Epoch: s.epoch, Action: "progress", ID: "id"})
	}
	if event := takeFile(t, a); event.Action != "reset" {
		t.Fatal(event)
	}
	if sub.done || sub.overrun || len(sub.pending) != 0 {
		t.Fatal("file overflow broke text")
	}
	// A byte overflow is independently bounded, even below the event limit.
	a.EnableFiles("b")
	s.enqueueFile(sub, terminalfile.Event{Type: "terminal-file", Epoch: s.epoch, Action: "request", Directory: strings.Repeat("x", 300*1024)})
	if event := takeFile(t, a); event.Action != "reset" {
		t.Fatal(event)
	}
}

func TestTerminateWorkspaceOnlyCancelsItsFileTransfers(t *testing.T) {
	manager := NewManager()
	t.Cleanup(manager.Close)
	attach := func(workspace string) (*ManagedSession, *Attachment) {
		s := &ManagedSession{
			manager: manager, workspaceID: workspace, paneID: "pane", epoch: "epoch",
			subscribers: map[*subscriber]struct{}{},
			scrollback:  scrollbackBuffer{limit: defaultScrollbackLimit},
		}
		manager.sessions[sessionKey(workspace, s.paneID)] = s
		a := s.subscribe(Cursor{OutputPaused: true})
		t.Cleanup(a.Unsubscribe)
		a.EnableFiles("client")
		return s, a
	}
	request := func(s *ManagedSession, a *Attachment, id string) *terminalfile.Transfer {
		manager.Files.Handle(s.workspaceID, s.paneID, s.epoch, terminalfile.Command{
			Action: "upload", ID: id, Directory: t.TempDir(),
		}, func(string) {})
		if event := takeFile(t, a); event.Action != "request" || event.ID != id {
			t.Fatalf("file invitation = %+v", event)
		}
		ticket, err := manager.Files.Claim(s.workspaceID, s.paneID, s.epoch, id, "client", []terminalfile.File{{Name: "test.txt", Bytes: 1}})
		if err != nil {
			t.Fatalf("claim file transfer: %v", err)
		}
		if event := takeFile(t, a); event.Action != "claimed" {
			t.Fatalf("file claim = %+v", event)
		}
		transfer, ok := manager.Files.Lookup(ticket)
		if !ok {
			t.Fatal("claimed transfer is missing")
		}
		return transfer
	}
	one, a := attach("one")
	two, b := attach("two")
	removed := request(one, a, "first")
	kept := request(two, b, "first")

	manager.TerminateWorkspace("one")
	if !one.isClosed() || two.isClosed() {
		t.Fatal("workspace teardown closed the wrong terminals")
	}
	if removed.Context.Err() == nil {
		t.Fatal("the deleted workspace's transfer was not cancelled")
	}
	if _, ok := manager.Files.Lookup(removed.Ticket); ok {
		t.Fatal("the deleted workspace's ticket remains usable")
	}
	if kept.Context.Err() != nil {
		t.Fatal("another workspace's transfer was cancelled")
	}
	if _, err := manager.Files.Begin(kept.Ticket, "upload", 0); err != nil {
		t.Fatalf("another workspace's ticket is unusable: %v", err)
	}
	manager.Files.Pause(kept.Ticket)
	request(two, b, "second")
	three, c := attach("three")
	request(three, c, "first")
}
