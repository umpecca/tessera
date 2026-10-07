package terminal

import (
	"strings"
	"tessera/internal/terminalaudio"
	"testing"
)

func TestStreamsAreLiveAndExcludedFromHistory(t *testing.T) {
	s, _ := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	a.EnableAudio(true)
	start := terminalaudio.Event{Action: "stream-start", ID: "music", Token: "first", Channels: 2, BufferMS: 100, PreSkip: 312}
	s.publish(terminalaudio.StreamSequence(start))
	if takeAudio(t, a).PreSkip != 312 {
		t.Fatal("initial pre-skip lost")
	}
	s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "music", Token: "first", Data: "AgD8AA=="}))
	if takeAudio(t, a).Action != "stream-data" {
		t.Fatal("missing packets")
	}
	if s.published != 0 || s.sequence != 0 || s.scrollback.size != 0 {
		t.Fatal("audio entered terminal history")
	}
	snapshot, err := s.core.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(snapshot), "tessera-audio") {
		t.Fatal("audio entered snapshot")
	}
	b := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer b.Unsubscribe()
	b.EnableAudio(true)
	join := takeAudio(t, b)
	if join.Action != "stream-start" || join.Sequence != 1 || join.PreSkip != 0 {
		t.Fatalf("bad live join %+v", join)
	}
	if _, ok := b.ReadAudio(); ok {
		t.Fatal("packets replayed")
	}
	s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "music", Token: "first", Sequence: 1, Data: "AgD8AA=="}))
	if takeAudio(t, a).Sequence != 1 || takeAudio(t, b).Sequence != 1 {
		t.Fatal("independent listeners missed live packet")
	}
	s.publish([]byte("text"))
	if string(s.scrollback.replay()) != "text" {
		t.Fatal("ordinary output changed")
	}
	// Replacement generations ignore delayed packets/aborts from their predecessor.
	start.Token = "second"
	s.publish(terminalaudio.StreamSequence(start))
	takeAudio(t, a)
	takeAudio(t, b)
	s.publish([]byte(terminalaudio.StreamPrefix + "abort;music;first" + terminalaudio.Terminator))
	if _, ok := a.ReadAudio(); ok {
		t.Fatal("old generation stopped replacement")
	}
	s.publish([]byte(terminalaudio.Prefix + "stop;music\a"))
	if takeAudio(t, a).Action != "stop" {
		t.Fatal("v1 stop did not stop stream")
	}
	if len(s.audioStreams) != 0 {
		t.Fatal("stop retained stream")
	}
}

func TestStreamOverflowResetsAndCanJoinFuturePackets(t *testing.T) {
	s, _ := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	a.EnableAudio(true)
	s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-start", ID: "a", Token: "b", Channels: 2, BufferMS: 500}))
	for i := uint64(0); i < 8; i++ {
		s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "a", Token: "b", Sequence: i, Data: "AgD8AA=="}))
	}
	if takeAudio(t, a).Action != "reset" {
		t.Fatal("missing reset")
	}
	if e := takeAudio(t, a); e.Action != "stream-start" || e.Sequence != 8 {
		t.Fatalf("missing fresh setup %+v", e)
	}
	s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "a", Token: "b", Sequence: 8, Data: "AgD8AA=="}))
	if takeAudio(t, a).Sequence != 8 {
		t.Fatal("live recovery failed")
	}
	s.publish(terminalaudio.StreamSequence(terminalaudio.Event{Action: "stream-data", ID: "a", Token: "b", Sequence: 10, Data: "AgD8AA=="}))
	if takeAudio(t, a).Action != "stop" || len(s.audioStreams) != 0 {
		t.Fatal("gap was not isolated")
	}
}
