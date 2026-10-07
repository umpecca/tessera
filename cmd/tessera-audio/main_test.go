package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"tessera/internal/terminalaudio"
	"testing"
	"time"
)

func sampleWAV() []byte {
	b := make([]byte, 46)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], 38)
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], 8000)
	binary.LittleEndian.PutUint32(b[28:], 16000)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], 2)
	return b
}

func TestHelperPlayFilesAndStdin(t *testing.T) {
	file := filepath.Join(t.TempDir(), "clip.without-extension")
	if err := os.WriteFile(file, sampleWAV(), 0600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"play", file, "--id", "clip"}, {"play", "-", "--format", "wav", "--id", "clip"}, {"play", "--format", "wav", file, "--id", "clip"}} {
		var out bytes.Buffer
		if err := run(args, bytes.NewReader(sampleWAV()), &out, nil); err != nil {
			t.Fatal(err)
		}
		e, _, ok := terminalaudio.Parse(strings.TrimSuffix(strings.TrimPrefix(out.String(), terminalaudio.Prefix), terminalaudio.Terminator))
		if !ok || e.Action != "play" || e.ID != "clip" || e.Format != "wav" {
			t.Fatalf("bad output %+v", e)
		}
	}
	var out bytes.Buffer
	if err := run([]string{"play", file}, bytes.NewReader(nil), &out, nil); err != nil {
		t.Fatal(err)
	}
	e, _, _ := terminalaudio.Parse(strings.TrimSuffix(strings.TrimPrefix(out.String(), terminalaudio.Prefix), terminalaudio.Terminator))
	if !terminalaudio.ValidID(e.ID) {
		t.Fatal("missing generated ID")
	}
	for _, args := range [][]string{nil, {"play", "-"}, {"play", file, "other"}, {"play", file, "--id", "bad id"}, {"play", file, "--id"}, {"play", file, "--format", "ogg"}, {"stop", "bad id"}, {"capabilities", "extra"}} {
		var output bytes.Buffer
		if err := run(args, bytes.NewReader(sampleWAV()), &output, nil); err == nil || output.Len() != 0 {
			t.Fatalf("accepted invalid args %+v", args)
		}
	}
	out.Reset()
	if err := run([]string{"play", "-", "--format", "mp3"}, bytes.NewReader(bytes.Repeat([]byte("A"), terminalaudio.MaxClipBytes+1)), &out, nil); err == nil || out.Len() != 0 {
		t.Fatal("oversized stdin accepted")
	}
}

func TestHelperStopAndCapabilitySerialization(t *testing.T) {
	for _, args := range [][]string{{"stop"}, {"stop", "clip"}} {
		var out bytes.Buffer
		if err := run(args, nil, &out, nil); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(out.String(), terminalaudio.Prefix+"stop;") || !strings.HasSuffix(out.String(), terminalaudio.Terminator) {
			t.Fatal("wrong stop framing")
		}
	}
	var out bytes.Buffer
	if err := run([]string{"capabilities"}, nil, &out, func() ([]byte, error) { return []byte(`{"version":1}`), nil }); err != nil || out.String() != "{\"version\":1}\n" {
		t.Fatal("capability output was not JSON")
	}
}

func TestCapabilityResponseMatchingTimeoutAndCancellation(t *testing.T) {
	_, wrong, _ := terminalaudio.Parse("query;wrong")
	_, right, _ := terminalaudio.Parse("query;right")
	chunks := []string{wrong, right[:12], right[12:]}
	data, err := readCapabilityResponse(context.Background(), "right", time.Now().Add(time.Second), func(time.Duration) ([]byte, error) {
		chunk := chunks[0]
		chunks = chunks[1:]
		return []byte(chunk), nil
	})
	if err != nil || !bytes.Contains(data, []byte(`"version":1`)) {
		t.Fatal(err)
	}
	if _, err := readCapabilityResponse(context.Background(), "x", time.Now().Add(-time.Second), nil); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatal("missing timeout")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := readCapabilityResponse(ctx, "x", time.Now().Add(time.Second), nil); !errors.Is(err, context.Canceled) {
		t.Fatal("query ignored cancellation")
	}
	if _, err := readCapabilityResponse(context.Background(), "x", time.Now().Add(time.Second), func(time.Duration) ([]byte, error) { return []byte{3}, nil }); err == nil {
		t.Fatal("query ignored Ctrl+C")
	}
	f, err := os.CreateTemp(t.TempDir(), "redirected")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := queryCapabilities(context.Background(), f, f); err == nil {
		t.Fatal("query accepted redirected I/O")
	}
}
