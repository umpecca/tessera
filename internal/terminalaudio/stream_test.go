package terminalaudio

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
)

func TestStreamFilterEverySplitAndCancellation(t *testing.T) {
	e := Event{Action: "stream-start", ID: "music", Token: "generation", Channels: 2, BufferMS: 500, PreSkip: 312}
	for _, ending := range []string{Terminator, "\a"} {
		sequence := strings.TrimSuffix(string(StreamSequence(e)), Terminator) + ending
		for split := 0; split <= len(sequence); split++ {
			var f StreamFilter
			var output []byte
			var events []Event
			for _, chunk := range []string{"before", sequence[:split], sequence[split:], "after"} {
				for _, part := range f.Feed([]byte(chunk)) {
					output = append(output, part.Text...)
					if part.Audio != nil {
						events = append(events, *part.Audio)
					}
				}
			}
			if string(output) != "beforeafter" || len(events) != 1 || events[0].BufferMS != 500 {
				t.Fatalf("split %d: %q %+v", split, output, events)
			}
		}
	}
	for _, sequence := range []string{StreamPrefix + "start;x;y;opus;2;500;0\x18", StreamPrefix + "start;x;y;opus;2;500;0\x1a",
		StreamPrefix + "start;x;y;opus;2;500;0\x1b[H", StreamPrefix + strings.Repeat("A", MaxStreamCommand+1) + "\a"} {
		var f StreamFilter
		for _, part := range f.Feed([]byte(sequence)) {
			if part.Audio != nil {
				t.Fatal("cancelled request played")
			}
		}
		if len(f.command) != 0 {
			t.Fatal("request memory retained")
		}
	}
	for _, input := range []string{"hello\x1b[31mred\x1b[0m", Prefix + "query;test\a", "\x1b]0;title\x1b\\", "\x1bPqdata\x1b\\", "\x1b]foo\x1b[H"} {
		for split := 0; split <= len(input); split++ {
			var f StreamFilter
			var output []byte
			for _, chunk := range []string{input[:split], input[split:]} {
				for _, p := range f.Feed([]byte(chunk)) {
					output = append(output, p.Text...)
				}
			}
			if string(output) != input {
				t.Fatalf("ordinary split %d: %q vs %q", split, output, input)
			}
		}
	}
}

func TestStreamValidation(t *testing.T) {
	data := base64.StdEncoding.EncodeToString([]byte{2, 0, 0xfc, 0})
	for _, command := range []string{"start;a;b;opus;2;100;312", "start;a;b;opus;1;2000;0", "data;a;b;0;0;" + data, "end;a;b;1", "abort;a;b"} {
		if _, ok := ParseStream(command); !ok {
			t.Fatalf("rejected %s", command)
		}
	}
	for _, command := range []string{"start;a;b;opus;2;99;0", "start;a;b;opus;3;500;0", "start;a;b;mp3;2;500;0", "data;a;b;0;960;" + data,
		"data;a;b;-1;0;" + data, "data;a;b;0;0;!!!", "data;a;b;0;0;", "end;a;b;9007199254740992"} {
		if _, ok := ParseStream(command); ok {
			t.Fatalf("accepted %s", command)
		}
	}
	if StreamFrames(bytes.Repeat([]byte{1, 0, 0xfc}, 6)) != nil {
		t.Fatal("accepted oversized batch")
	}
}

func TestCancelledStreamFollowedByNewOSC(t *testing.T) {
	sequence := StreamPrefix + "start;old;old;opus;2;500;0" + string(StreamSequence(Event{Action: "stream-start", ID: "new", Token: "new", Channels: 2, BufferMS: 500})) + "after"
	for split := 0; split <= len(sequence); split++ {
		var f StreamFilter
		var output []byte
		var events []Event
		for _, chunk := range []string{sequence[:split], sequence[split:]} {
			for _, part := range f.Feed([]byte(chunk)) {
				output = append(output, part.Text...)
				if part.Audio != nil {
					events = append(events, *part.Audio)
				}
			}
		}
		if string(output) != "after" || len(events) != 1 || events[0].ID != "new" {
			t.Fatalf("split %d: %q %+v", split, output, events)
		}
	}
}
