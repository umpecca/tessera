package terminalcore

import (
	"encoding/base64"
	"strings"
	"tessera/internal/terminalaudio"
	"testing"
)

func TestAudioOSCFragmentationAndCancellation(t *testing.T) {
	c, err := New(20, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	for _, terminator := range []string{terminalaudio.Terminator, "\a"} {
		sequence := terminalaudio.Prefix + "play;clip;mp3;" + base64.StdEncoding.EncodeToString([]byte("ID3example")) + terminator
		for split := 0; split <= len(sequence); split++ {
			if err := c.Write([]byte(sequence[:split])); err != nil {
				t.Fatal(err)
			}
			first, _, err := c.Audio()
			if err != nil || (split < len(sequence) && len(first) != 0) {
				t.Fatalf("early audio at %d: %v", split, err)
			}
			if err := c.Write([]byte(sequence[split:])); err != nil {
				t.Fatal(err)
			}
			last, _, err := c.Audio()
			events := append(first, last...)
			if err != nil || len(events) != 1 || events[0].ID != "clip" {
				t.Fatalf("split %d: %+v %v", split, events, err)
			}
		}
	}
	for _, sequence := range []string{
		terminalaudio.Prefix + "stop;*\x18", terminalaudio.Prefix + "stop;*\x1a", terminalaudio.Prefix + "stop;*\x1b[H",
		"\x1b]777;other;1;stop;*\a", "\x1b]777;tessera-audio;2;stop;*\a", terminalaudio.Prefix + "reset\a",
		terminalaudio.Prefix + "play;x;mp3;!bad!\a", terminalaudio.Prefix + "play;x;mp3;" + strings.Repeat("A", 1024*1024+128) + "\a",
	} {
		if err := c.Write([]byte(sequence)); err != nil {
			t.Fatal(err)
		}
		events, replies, err := c.Audio()
		if err != nil || len(events) != 0 || len(replies) != 0 {
			t.Fatalf("invalid OSC produced an effect: %d %v", len(events), err)
		}
	}
	c.Write([]byte("\x1b]0;title\a\x1b[H\x1b[6n"))
	reply, _ := c.Replies()
	if string(reply) != "\x1b[1;1R" {
		t.Fatalf("ordinary parser failed: %q", reply)
	}
}

func TestAudioQueryResetAndBoundedNativeEffects(t *testing.T) {
	c, err := New(20, 6)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte(terminalaudio.Prefix + "query;test\a"))
	events, reply, err := c.Audio()
	if err != nil || len(events) != 0 {
		t.Fatal(err)
	}
	if _, ok := terminalaudio.CapabilityReply(reply, "test"); !ok {
		t.Fatal("host cannot discover audio")
	}
	if ordinary, _ := c.Replies(); len(ordinary) != 0 {
		t.Fatal("query replied twice")
	}
	c.Write([]byte(strings.Repeat(terminalaudio.Prefix+"stop;*\a", 100)))
	events, _, err = c.Audio()
	if err != nil || len(events) > 8 || events[0].Action != "reset" {
		t.Fatalf("unbounded native effects: %+v %v", events, err)
	}
	c.Write([]byte("\x1bc"))
	events, _, err = c.Audio()
	if err != nil || len(events) != 1 || events[0].Action != "reset" {
		t.Fatal("shell reset missed audio cleanup")
	}
}
