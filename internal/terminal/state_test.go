package terminal

import (
	"bytes"
	"encoding/binary"
	"tessera/internal/terminalcore"
	"testing"
	"time"
)

func stateSession(t *testing.T) (*ManagedSession, *writeTestPTY) {
	t.Helper()
	core, err := terminalcore.New(80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(core.Close)
	pty := &writeTestPTY{}
	s := &ManagedSession{core: core, session: &Session{pty: pty}, epoch: "test-shell", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16, subscribers: map[*subscriber]struct{}{}}
	s.scrollback.limit = defaultScrollbackLimit
	return s, pty
}
func nextState(t *testing.T, a *Attachment) []byte {
	t.Helper()
	select {
	case frame := <-a.Events:
		return frame
	case <-time.After(time.Second):
		t.Fatal("state event missing")
		return nil
	}
}
func TestStateSnapshotAndLiveOrdering(t *testing.T) {
	s, _ := stateSession(t)
	s.publish([]byte("before\x1bPq#1;2;100;0;0!8"))
	a := s.subscribe(Cursor{Protocol: StateProtocol})
	defer a.Unsubscribe()
	if a.Err != nil || !a.Reset || !bytes.HasPrefix(a.Snapshot, []byte("TSS2")) {
		t.Fatalf("snapshot: %+v", a)
	}
	s.publish([]byte("~\x1b\\after"))
	if err := s.ResizeWithMetrics(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	output, geometry := nextState(t, a), nextState(t, a)
	if output[0] != StateOutput || geometry[0] != StateGeometry {
		t.Fatalf("events %v %v", output[0], geometry[0])
	}
	if binary.LittleEndian.Uint64(output[1:]) != a.Sequence+1 || binary.LittleEndian.Uint64(geometry[1:]) != a.Sequence+2 {
		t.Fatal("snapshot/live gap")
	}
	resume := s.subscribe(Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: a.Epoch, Sequence: a.Sequence, Offset: a.Offset})
	defer resume.Unsubscribe()
	if resume.Reset || !bytes.Equal(resume.Replay, append(output, geometry...)) {
		t.Fatal("ordered replay differs from live events")
	}
}
func TestStateRepliesOnceAndClipboardOnlyLive(t *testing.T) {
	s, pty := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol})
	defer a.Unsubscribe()
	b := s.subscribe(Cursor{Protocol: StateProtocol})
	defer b.Unsubscribe()
	s.publish([]byte("\x1b[c\x1b[6n\x1b]52;c;aGVsbG8=\x07"))
	if got := pty.String(); got != "\x1b[?62;4c\x1b[1;1R" {
		t.Fatalf("duplicate/missing replies: %q", got)
	}
	for _, attachment := range []*Attachment{a, b} {
		nextState(t, attachment)
		effect := nextState(t, attachment)
		if effect[0] != StateClipboard || string(effect[StateFrameHeader:]) != "hello" {
			t.Fatalf("clipboard %q", effect)
		}
	}
	replay := s.subscribe(Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: a.Epoch, Sequence: a.Sequence, Offset: a.Offset})
	defer replay.Unsubscribe()
	data := replay.Replay
	for len(data) > 0 {
		n := int(binary.LittleEndian.Uint32(data[17:]))
		if data[0] == StateClipboard && n != 0 {
			t.Fatal("clipboard replayed")
		}
		data = data[StateFrameHeader+n:]
	}
	fresh := s.subscribe(Cursor{Protocol: StateProtocol})
	defer fresh.Unsubscribe()
	if fresh.Err != nil {
		t.Fatal(fresh.Err)
	}
	if got := pty.String(); got != "\x1b[?62;4c\x1b[1;1R" {
		t.Fatal("snapshot produced replies")
	}
}
func TestStateFallbackAfterReplayEviction(t *testing.T) {
	s, _ := stateSession(t)
	s.publish([]byte("\x1bPq#1;2;100;0;0!8~\x1b\\"))
	old := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch, Sequence: s.sequence, Offset: s.published}
	output := bytes.Repeat([]byte("\x1b[0m"), 2048)
	for i := 0; i < 513; i++ {
		s.publish(output)
	}
	a := s.subscribe(old)
	defer a.Unsubscribe()
	if !a.Reset || a.Err != nil || len(a.Snapshot) == 0 {
		t.Fatalf("snapshot fallback failed: %v", a.Err)
	}
	if s.stateBytes > defaultScrollbackLimit {
		t.Fatal("replay exceeds budget")
	}
	if a.Sequence != s.sequence || a.Offset != s.published {
		t.Fatal("snapshot cutoff differs from event order")
	}
}

func TestImageControlsSharedAndReplayed(t *testing.T) {
	s, pty := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol})
	defer a.Unsubscribe()
	b := s.subscribe(Cursor{Protocol: StateProtocol})
	defer b.Unsubscribe()
	budget, markers := 16, false
	if err := s.ConfigureImages(&budget, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.ConfigureImages(nil, &markers); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearImages(); err != nil {
		t.Fatal(err)
	}
	var recorded []byte
	for i, kind := range []byte{StateImageSettings, StateImageSettings, StateClearImages} {
		first, second := nextState(t, a), nextState(t, b)
		if !bytes.Equal(first, second) || first[0] != kind {
			t.Fatal("replicas received different image controls")
		}
		if binary.LittleEndian.Uint64(first[1:]) != a.Sequence+uint64(i)+1 {
			t.Fatal("image control ordering gap")
		}
		recorded = append(recorded, first...)
	}
	gotBudget, gotMarkers, err := s.core.ImageSettings()
	if err != nil || gotBudget != 16 || gotMarkers {
		t.Fatalf("partial settings lost: %d %v %v", gotBudget, gotMarkers, err)
	}
	resume := s.subscribe(Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: a.Epoch, Sequence: a.Sequence, Offset: a.Offset})
	defer resume.Unsubscribe()
	if resume.Reset || !bytes.Equal(resume.Replay, recorded) {
		t.Fatal("image control replay differs")
	}
	if pty.String() != "" {
		t.Fatal("image controls wrote shell input")
	}
}
