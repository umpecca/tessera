package terminal

import (
	"strings"
	"tessera/internal/terminalaudio"
	"tessera/internal/terminalcore"
	"testing"
	"time"
)

func takeAudio(t *testing.T, a *Attachment) terminalaudio.Event {
	t.Helper()
	select {
	case <-a.AudioWake:
	case <-time.After(time.Second):
		t.Fatal("missing live audio")
	}
	event, ok := a.ReadAudio()
	if !ok {
		t.Fatal("audio wake had no event")
	}
	return event
}

func TestAudioLiveSubscribersAreIndependentOfTextAndReplay(t *testing.T) {
	s, pty := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	b := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer b.Unsubscribe()
	disabled := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer disabled.Unsubscribe()
	a.EnableAudio(true)
	b.EnableAudio(true)
	s.publish([]byte(terminalaudio.Prefix + "stop;clip\a"))
	for _, listener := range []*Attachment{a, b} {
		event := takeAudio(t, listener)
		if event.Action != "stop" || event.ID != "clip" || event.Epoch != s.epoch {
			t.Fatalf("bad audio: %+v", event)
		}
		select {
		case <-listener.Events:
			t.Fatal("audio resumed hidden text")
		default:
		}
	}
	if _, ok := disabled.ReadAudio(); ok {
		t.Fatal("audio was not opt-in")
	}
	cursor := Cursor{Protocol: StateProtocol, Core: terminalcore.Compatibility, Epoch: s.epoch, Sequence: s.sequence, Offset: s.published}
	s.publish([]byte(terminalaudio.Prefix + "query;nonce\a"))
	if _, ok := terminalaudio.CapabilityReply([]byte(pty.String()), "nonce"); !ok {
		t.Fatal("host did not answer capability query")
	}
	restored := s.subscribe(cursor)
	defer restored.Unsubscribe()
	restored.EnableAudio(true)
	if _, ok := restored.ReadAudio(); ok {
		t.Fatal("historical audio was replayed")
	}
	if len(restored.Replay) == 0 {
		t.Fatal("ordinary output did not replay")
	}
	b.EnableAudio(false)
	s.publish([]byte(terminalaudio.Prefix + "stop;*\a"))
	if takeAudio(t, a).ID != "*" {
		t.Fatal("remaining listener missed audio")
	}
	if _, ok := b.ReadAudio(); ok {
		t.Fatal("disabled listener received audio")
	}
}

func TestAudioQueueOverflowResetsOnlyAudio(t *testing.T) {
	s, _ := stateSession(t)
	a := s.subscribe(Cursor{Protocol: StateProtocol, OutputPaused: true})
	defer a.Unsubscribe()
	a.EnableAudio(true)
	for range 9 {
		s.publish([]byte(terminalaudio.Prefix + "stop;*\a"))
	}
	if event := takeAudio(t, a); event.Action != "reset" {
		t.Fatalf("overflow did not reset audio: %+v", event)
	}
	if _, ok := a.ReadAudio(); ok {
		t.Fatal("overflow retained old events")
	}
	for sub := range s.subscribers {
		if sub.done || sub.overrun || len(sub.pending) != 0 {
			t.Fatal("audio overflow affected text lifecycle")
		}
	}
	s.publish([]byte(terminalaudio.Prefix + "stop;next\a"))
	if takeAudio(t, a).ID != "next" {
		t.Fatal("audio did not recover")
	}
	s.mu.Lock()
	for sub := range s.subscribers {
		for range 3 {
			s.enqueueAudioLocked(sub, terminalaudio.Event{Type: "terminal-audio", Epoch: s.epoch, Action: "play", ID: "large", Data: strings.Repeat("A", 699052)})
		}
		if sub.audioBytes > maximumAudioQueueBytes || len(sub.audioPending) > maximumAudioEvents {
			t.Fatal("audio byte budget exceeded")
		}
	}
	s.mu.Unlock()
}
