package terminal

import (
	"bytes"
	"encoding/binary"
	"errors"
	"sync"
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

func TestHiddenAttachmentSkipsSnapshotAndKeepsHostRepliesAndVisibleClientsLive(t *testing.T) {
	s, pty := stateSession(t)
	s.publish(bytes.Repeat([]byte("retained text\r\n"), 1000))
	hidden := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer hidden.Unsubscribe()
	visible := s.subscribe(Cursor{Protocol: StateProtocol})
	defer visible.Unsubscribe()
	if hidden.Err != nil || len(hidden.Snapshot) != 0 || len(hidden.Replay) != 0 || hidden.Reset {
		t.Fatalf("hidden attachment built state: %+v", hidden)
	}
	s.publish([]byte("\x1b[H\x1b[6n\x1b]52;c;aGVsbG8=\x07"))
	if pty.String() != "\x1b[1;1R" {
		t.Fatalf("host replies while hidden: %q", pty.String())
	}
	if nextState(t, visible)[0] != StateOutput || nextState(t, visible)[0] != StateClipboard {
		t.Fatal("visible attachment missed live output/effects")
	}
	s.mu.Lock()
	badQueue := false
	for sub := range s.subscribers {
		if sub.paused && (len(sub.pending) != 0 || sub.bytes != 0 || sub.done) {
			badQueue = true
		}
	}
	s.mu.Unlock()
	if badQueue {
		t.Fatal("hidden attachment queued output or disconnected")
	}
	select {
	case <-hidden.Events:
		t.Fatal("hidden attachment received an event")
	default:
	}
	s.markExited(nil)
	s.finish()
	if _, open := receiveChunk(t, hidden.Events); open {
		t.Fatal("hidden lifecycle did not finish")
	}
	if exited, err := s.Exited(); !exited || err != nil {
		t.Fatalf("exit lost while hidden: %v %v", exited, err)
	}
}

func TestPausingClearsQueuedOutputAndRetainsExitNotice(t *testing.T) {
	s, _ := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol})
	defer a.Unsubscribe()
	for i := 0; i < 100; i++ {
		s.publish([]byte("queued build output\r\n"))
	}
	a.PauseOutput()
	a.PauseOutput()
	for i := 0; i < 100; i++ {
		s.publish([]byte("hidden build output\r\n"))
	}
	s.mu.Lock()
	badQueue := false
	for sub := range s.subscribers {
		if !sub.paused || len(sub.pending) != 0 || sub.bytes != 0 || sub.done {
			badQueue = true
		}
	}
	s.mu.Unlock()
	if badQueue {
		t.Fatal("paused queue retained state")
	}
	s.markExited(errors.New("shell failed"))
	s.finish()
	// A send selected before pause may be in flight; socket serialization drops
	// it before acknowledging the pause. The pump must still close promptly.
	for {
		if _, open := receiveChunk(t, a.Events); !open {
			break
		}
	}
	if exited, err := s.Exited(); !exited || err == nil || err.Error() != "shell failed" {
		t.Fatalf("exit failure lost: %v %v", exited, err)
	}
}

func TestRevealSnapshotsChangedStateAndResumesAnUnchangedView(t *testing.T) {
	s, _ := stateSession(t)
	s.publish([]byte("before hiding\r\n"))
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
		Sequence: s.sequence, Offset: s.published, SnapshotIfChanged: true}
	idle := s.subscribe(cursor)
	defer idle.Unsubscribe()
	if idle.Reset || len(idle.Snapshot) != 0 || len(idle.Replay) != 0 || idle.Sequence != cursor.Sequence || idle.Offset != cursor.Offset {
		t.Fatal("unchanged view was replaced")
	}
	s.publish([]byte("hidden output\r\n"))
	changed := s.subscribe(cursor)
	defer changed.Unsubscribe()
	if !changed.Reset || len(changed.Snapshot) == 0 || len(changed.Replay) != 0 || changed.Sequence != s.sequence || changed.Offset != s.published {
		t.Fatal("changed state replayed hidden output instead of a current snapshot")
	}
	// Geometry and image controls also change state without changing byte offset.
	cursor.Sequence, cursor.Offset = s.sequence, s.published
	budget := 16
	if err := s.ConfigureImages(&budget, nil); err != nil {
		t.Fatal(err)
	}
	configured := s.subscribe(cursor)
	defer configured.Unsubscribe()
	if !configured.Reset || len(configured.Snapshot) == 0 || configured.Offset != cursor.Offset || configured.Sequence == cursor.Sequence {
		t.Fatal("non-output state changes were missed")
	}
}

func TestPauseUnsubscribeAndExitAreSafeWhenTheyRace(t *testing.T) {
	session := newTestSession(1 << 20)
	a := session.subscribe(Cursor{})
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(2)
		go func() { defer workers.Done(); a.PauseOutput() }()
		go func() { defer workers.Done(); a.Unsubscribe() }()
	}
	workers.Add(1)
	go func() { defer workers.Done(); session.finish() }()
	workers.Wait()
	if _, open := receiveChunk(t, a.Events); open {
		t.Fatal("racing lifecycle left the pump open")
	}
}

func TestPausedAttachmentSkipsSixteenMiBWhileAVisibleClientReceivesIt(t *testing.T) {
	s, _ := stateSession(t)
	hidden := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer hidden.Unsubscribe()
	visible := s.subscribe(Cursor{Protocol: StateProtocol})
	defer visible.Unsubscribe()
	const chunks = 256
	payload := bytes.Repeat([]byte("\rbuild123456789\r"), 4096) // 64 KiB progress updates.
	if len(payload) != 64*1024 {
		t.Fatalf("stress payload size=%d", len(payload))
	}
	totals := make(chan int, 1)
	go func() {
		total := 0
		for i := 0; i < chunks; i++ {
			frame, open := <-visible.Events
			if !open || len(frame) != len(payload)+StateFrameHeader || frame[0] != StateOutput || binary.LittleEndian.Uint64(frame[1:]) != visible.Sequence+uint64(i)+1 {
				totals <- -1
				return
			}
			total += len(frame) - StateFrameHeader
		}
		totals <- total
	}()
	started := time.Now()
	for i := 0; i < chunks; i++ {
		s.publish(payload)
	}
	select {
	case total := <-totals:
		if total != 16*1024*1024 {
			t.Fatalf("visible client received %d bytes", total)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("visible delivery stalled behind a paused attachment")
	}
	s.mu.Lock()
	badQueue := false
	for sub := range s.subscribers {
		badQueue = badQueue || (sub.paused && (sub.bytes != 0 || len(sub.pending) != 0 || sub.done))
	}
	s.mu.Unlock()
	if badQueue {
		t.Fatal("hidden output accumulated or the attachment disconnected")
	}
	select {
	case <-hidden.Events:
		t.Fatal("paused attachment received hidden output")
	default:
	}
	resumed := s.subscribe(Cursor{Protocol: StateProtocol, SnapshotIfChanged: true, Core: terminalcore.Compatibility,
		Epoch: visible.Epoch, Sequence: visible.Sequence, Offset: visible.Offset})
	defer resumed.Unsubscribe()
	if !resumed.Reset || len(resumed.Replay) != 0 || len(resumed.Snapshot) == 0 || resumed.Sequence != s.sequence || resumed.Offset != s.published {
		t.Fatal("stress reveal did not catch up to the host snapshot")
	}
	t.Logf("16 MiB delivered to visible client in %s; paused queue and output=0; snapshot=%d bytes", time.Since(started), len(resumed.Snapshot))
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

func TestStateAttachmentRetentionAndForcedFreshSnapshot(t *testing.T) {
	s, _ := stateSession(t)
	s.scrollback.limit = 128
	s.publish([]byte("screen state"))
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch, Sequence: s.sequence, Offset: s.published}
	resume := s.subscribe(cursor)
	defer resume.Unsubscribe()
	if resume.Reset || resume.RetainedOutputBytes != 128 {
		t.Fatalf("resume reset=%v retention=%d", resume.Reset, resume.RetainedOutputBytes)
	}
	// Backlog recovery omits the resume cursor. Even while that cursor is
	// retained, the host must send a fresh snapshot of the same running shell.
	fresh := s.subscribe(Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility})
	defer fresh.Unsubscribe()
	if !fresh.Reset || fresh.Err != nil || len(fresh.Snapshot) == 0 || len(fresh.Replay) != 0 {
		t.Fatalf("fresh attachment reset=%v snapshot=%d replay=%d err=%v", fresh.Reset, len(fresh.Snapshot), len(fresh.Replay), fresh.Err)
	}
	if fresh.Epoch != resume.Epoch || fresh.Sequence != cursor.Sequence || fresh.Offset != cursor.Offset || fresh.RetainedOutputBytes != 128 {
		t.Fatal("snapshot changed the shell or attachment cutoff")
	}
	s.scrollback.limit = 0
	fallback := s.subscribe(cursor)
	defer fallback.Unsubscribe()
	if fallback.RetainedOutputBytes != defaultScrollbackLimit {
		t.Fatalf("fallback retention = %d", fallback.RetainedOutputBytes)
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
func TestOutputTimingRecordsReadAndQueueTimes(t *testing.T) {
	s, _ := stateSession(t)
	s.started = time.Now().Add(-time.Second)
	s.publishRead([]byte("frame"), s.started.Add(500*time.Millisecond))
	sequence := s.sequence
	timing, ok := s.OutputTimingFor(sequence)
	if !ok || timing.Sequence != sequence || timing.ReadUs != 500_000 || timing.QueuedUs < timing.ReadUs {
		t.Fatalf("timing %+v ok=%v", timing, ok)
	}
	if err := s.ResizeWithMetrics(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.OutputTimingFor(s.sequence); ok {
		t.Fatal("non-output event has output timing")
	}
	if _, ok := s.OutputTimingFor(sequence + outputTimingSlots); ok {
		t.Fatal("slot reuse matched a different sequence")
	}
}
