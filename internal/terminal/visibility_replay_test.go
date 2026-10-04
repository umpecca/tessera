package terminal

import (
	"bytes"
	"encoding/binary"
	"testing"

	"tessera/internal/terminalcore"
)

func TestVisibilityCatchUpReplaysSmallOrderedGapAndKeepsEffectsLiveOnly(t *testing.T) {
	s, pty := stateSession(t)
	s.publish(bytes.Repeat([]byte("previous build output\r\n"), 2000))
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
		Sequence: s.sequence, Offset: s.published, SnapshotIfChanged: true, CatchUpReplay: true}
	hidden := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer hidden.Unsubscribe()
	s.publish([]byte("\x1b[31"))
	s.publish([]byte("mbuild progress\x1b[0m\r\n"))
	if err := s.ResizeWithMetrics(100, 30, 9, 18); err != nil {
		t.Fatal(err)
	}
	if err := s.Configure(true); err != nil {
		t.Fatal(err)
	}
	budget := 16
	if err := s.ConfigureImages(&budget, nil); err != nil {
		t.Fatal(err)
	}
	if err := s.ClearImages(); err != nil {
		t.Fatal(err)
	}
	s.publish([]byte("\x1b[6n\x1b]52;c;aGlkZGVu\a"))
	cutoff := s.sequence
	a := s.subscribe(cursor)
	defer a.Unsubscribe()
	if a.Err != nil || a.Reset || len(a.Snapshot) != 0 || len(a.Replay) == 0 ||
		a.Sequence != cursor.Sequence || a.Offset != cursor.Offset {
		t.Fatalf("small gap did not replay: reset=%v snapshot=%d replay=%d err=%v", a.Reset, len(a.Snapshot), len(a.Replay), a.Err)
	}
	var kinds []byte
	sequence := cursor.Sequence
	for data := a.Replay; len(data) > 0; {
		sequence++
		if len(data) < StateFrameHeader || binary.LittleEndian.Uint64(data[1:]) != sequence {
			t.Fatal("replay sequence gap")
		}
		n := int(binary.LittleEndian.Uint32(data[17:]))
		if n > len(data)-StateFrameHeader || (data[0] == StateClipboard && n != 0) {
			t.Fatal("invalid replay or repeated clipboard effect")
		}
		kinds = append(kinds, data[0])
		data = data[StateFrameHeader+n:]
	}
	if !bytes.Equal(kinds, []byte{StateOutput, StateOutput, StateGeometry, StateConfiguration,
		StateImageSettings, StateClearImages, StateOutput, StateClipboard}) || sequence != cutoff {
		t.Fatalf("replay kinds=%v cutoff=%d want=%d", kinds, sequence, cutoff)
	}
	if pty.String() == "" {
		t.Fatal("host did not answer hidden query")
	}
	replies := pty.String()
	s.publish([]byte("live"))
	if frame := nextState(t, a); frame[0] != StateOutput || binary.LittleEndian.Uint64(frame[1:]) != cutoff+1 {
		t.Fatal("live output did not follow the replay cutoff")
	}
	if pty.String() != replies {
		t.Fatal("attachment answered queries twice")
	}
	select {
	case <-hidden.Events:
		t.Fatal("hidden attachment resumed output during catch-up")
	default:
	}
}

func TestVisibilityCatchUpReplayBounds(t *testing.T) {
	for _, tc := range []struct {
		name     string
		bytes    int
		events   int
		snapshot bool
	}{
		{"exact_bytes", maximumCatchUpReplayBytes - StateFrameHeader, 1, false},
		{"over_bytes", maximumCatchUpReplayBytes - StateFrameHeader + 1, 1, true},
		{"exact_events", 1, maximumCatchUpReplayEvents, false},
		{"over_events", 1, maximumCatchUpReplayEvents + 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := stateSession(t)
			cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
				SnapshotIfChanged: true, CatchUpReplay: true}
			for range tc.events {
				s.publish(bytes.Repeat([]byte("\r"), tc.bytes))
			}
			a := s.subscribe(cursor)
			defer a.Unsubscribe()
			if a.Err != nil || a.Reset != tc.snapshot {
				t.Fatalf("reset=%v want=%v err=%v", a.Reset, tc.snapshot, a.Err)
			}
			if tc.snapshot {
				if len(a.Replay) != 0 || len(a.Snapshot) == 0 || a.Sequence != s.sequence || a.Offset != s.published {
					t.Fatal("snapshot did not replace the large replay at the current cutoff")
				}
			} else if len(a.Replay) > maximumCatchUpReplayBytes || len(a.Snapshot) != 0 {
				t.Fatal("small replay exceeded its bound or also captured a snapshot")
			}
		})
	}
}

func TestVisibilityCatchUpCountsSanitizedClipboardWireSize(t *testing.T) {
	s, _ := stateSession(t)
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
		SnapshotIfChanged: true, CatchUpReplay: true}
	s.mu.Lock()
	s.publishStateLocked(StateClipboard, bytes.Repeat([]byte("x"), maximumCatchUpReplayBytes+1))
	s.mu.Unlock()
	a := s.subscribe(cursor)
	defer a.Unsubscribe()
	if a.Err != nil || a.Reset || len(a.Replay) != StateFrameHeader || a.Replay[0] != StateClipboard ||
		binary.LittleEndian.Uint32(a.Replay[17:]) != 0 {
		t.Fatal("discarded clipboard payload triggered a snapshot or replayed its effect")
	}
}

func TestVisibilityCatchUpRejectsUnavailableOrMismatchedCursors(t *testing.T) {
	for _, mismatch := range []string{"epoch", "core", "sequence", "offset", "evicted"} {
		t.Run(mismatch, func(t *testing.T) {
			s, _ := stateSession(t)
			s.publish([]byte("before"))
			cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
				Sequence: s.sequence, Offset: s.published, SnapshotIfChanged: true, CatchUpReplay: true}
			if mismatch == "evicted" {
				s.scrollback.limit = 64
				s.publish(bytes.Repeat([]byte("\r"), 100))
			} else {
				s.publish([]byte("after"))
			}
			switch mismatch {
			case "epoch":
				cursor.Epoch = "other-shell"
			case "core":
				cursor.Core = "other-core"
			case "sequence":
				cursor.Sequence = s.sequence + 1
			case "offset":
				cursor.Offset++
			}
			a := s.subscribe(cursor)
			defer a.Unsubscribe()
			if a.Err != nil || !a.Reset || len(a.Snapshot) == 0 || len(a.Replay) != 0 {
				t.Fatalf("invalid cursor replayed: reset=%v err=%v", a.Reset, a.Err)
			}
		})
	}
}

func TestVisibilityCatchUpIdleViewAndLegacySnapshotPolicy(t *testing.T) {
	s, _ := stateSession(t)
	s.publish([]byte("before"))
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
		Sequence: s.sequence, Offset: s.published, SnapshotIfChanged: true, CatchUpReplay: true}
	idle := s.subscribe(cursor)
	defer idle.Unsubscribe()
	if idle.Reset || len(idle.Replay) != 0 || len(idle.Snapshot) != 0 {
		t.Fatal("unchanged view was replaced")
	}
	s.publish([]byte("small change"))
	cursor.CatchUpReplay = false
	legacy := s.subscribe(cursor)
	defer legacy.Unsubscribe()
	if legacy.Err != nil || !legacy.Reset || len(legacy.Snapshot) == 0 || len(legacy.Replay) != 0 {
		t.Fatal("old client's snapshot-on-change request was ignored")
	}
}

func BenchmarkVisibilityCatchUp(b *testing.B) {
	for _, mode := range []string{"snapshot", "bounded_replay"} {
		b.Run(mode, func(b *testing.B) {
			core, err := terminalcore.New(80, 24)
			if err != nil {
				b.Fatal(err)
			}
			defer core.Close()
			s := &ManagedSession{core: core, epoch: "benchmark", cols: 80, rows: 24, cellWidth: 8, cellHeight: 16}
			s.scrollback.limit = defaultScrollbackLimit
			s.publish(bytes.Repeat([]byte("previous build output for module 0123456789\r\n"), 2000))
			cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch,
				Sequence: s.sequence, Offset: s.published, SnapshotIfChanged: true, CatchUpReplay: mode == "bounded_replay"}
			s.publish([]byte("\r\x1b[2KBuilding module 123/456"))
			sample := &Attachment{}
			s.stateAttachLocked(cursor, sample)
			if sample.Err != nil {
				b.Fatal(sample.Err)
			}
			stateBytes := len(sample.Replay) + len(sample.Snapshot)
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				a := &Attachment{}
				s.mu.Lock()
				s.stateAttachLocked(cursor, a)
				s.mu.Unlock()
				if a.Err != nil {
					b.Fatal(a.Err)
				}
			}
			b.StopTimer()
			b.ReportMetric(float64(stateBytes), "state-B/op")
		})
	}
}
