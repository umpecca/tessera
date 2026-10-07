package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"os/exec"
	"strings"
	"tessera/internal/terminalaudio"
	"testing"
)

func TestStreamOptions(t *testing.T) {
	o, err := parseStreamOptions([]string{"-", "--buffer-ms", "100", "--bitrate", "64k"})
	if err != nil || o.bufferMS != 100 || o.bitrate != 64 {
		t.Fatal(o, err)
	}
	for _, args := range [][]string{nil, {"x", "--buffer-ms", "99"}, {"x", "--bitrate", "999k"}, {"x", "--id", "bad id"}, {"x", "--ffmpeg"}} {
		if _, err := parseStreamOptions(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	var out bytes.Buffer
	if err := stream(context.Background(), []string{"-", "--ffmpeg", "missing-tessera-encoder"}, nil, &out); err == nil || out.Len() != 0 {
		t.Fatal("missing encoder did not fail cleanly")
	}
}

func TestRealFFmpegStreamStdinAndCancellation(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("FFmpeg not installed")
	}
	var out bytes.Buffer
	wav := append(sampleWAV()[:44], bytes.Repeat([]byte{0, 1}, 800)...)
	binary.LittleEndian.PutUint32(wav[4:], uint32(len(wav)-8))
	binary.LittleEndian.PutUint32(wav[40:], uint32(len(wav)-44))
	if err := stream(context.Background(), []string{"-", "--id", "tone", "--buffer-ms", "100"}, bytes.NewReader(wav), &out); err != nil {
		t.Fatal(err)
	}
	var f terminalaudio.StreamFilter
	var events []terminalaudio.Event
	for _, part := range f.Feed(out.Bytes()) {
		if part.Audio != nil {
			events = append(events, *part.Audio)
		}
		if len(part.Text) != 0 {
			t.Fatal("helper emitted ordinary text")
		}
	}
	if len(events) < 3 || events[0].Action != "stream-start" || events[len(events)-1].Action != "stream-end" || events[0].BufferMS != 100 {
		t.Fatalf("bad stream %+v", events)
	}
	if events[len(events)-2].Discard == 0 {
		t.Fatal("short file lost end padding")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := stream(ctx, []string{"-"}, bytes.NewReader(sampleWAV()), &bytes.Buffer{}); err == nil {
		t.Fatal("ignored cancellation")
	}
	bad := []byte("OggS" + strings.Repeat("\x00", 23))
	binaryPage := append([]byte(nil), bad...)
	if err := readOgg(bytes.NewReader(binaryPage), func([]byte, bool, uint64) error { return nil }); err == nil {
		t.Fatal("malformed Ogg accepted")
	}
}
