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
