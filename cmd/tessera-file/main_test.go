package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/terminalfile"
)

func TestCommandsResolveActualCWDAndSerialize(t *testing.T) {
	for _, args := range [][]string{{"upload"}, {"upload", "--to", "."}, {"download", "a", "b"}, {"cancel", "a_1"}, {"capabilities"}} {
		c, err := command(args)
		if err != nil {
			t.Fatal(err)
		}
		s, err := terminalfile.Serialize(c)
		if err != nil || !strings.HasSuffix(s, terminalfile.Terminator) {
			t.Fatal(err)
		}
		if c.Action == "upload" && !filepath.IsAbs(c.Directory) {
			t.Fatal(c.Directory)
		}
		for _, p := range c.Paths {
			if !filepath.IsAbs(p) {
				t.Fatal(p)
			}
		}
	}
	for _, args := range [][]string{nil, {"upload", "other"}, {"download"}, {"cancel", "bad;id"}, {"capabilities", "extra"}} {
		if _, err := command(args); err == nil {
			t.Fatal(args)
		}
	}
}
func TestReplyMatchingFragmentsAndProgress(t *testing.T) {
	sequence := terminalfile.Reply("other", terminalfile.Result{State: "pending"}) + terminalfile.Reply("mine", terminalfile.Result{State: "pending"}) + terminalfile.Reply("mine", terminalfile.Result{State: "sent"})
	for split := 0; split <= len(sequence); split++ {
		chunks := [][]byte{[]byte(sequence[:split]), []byte(sequence[split:])}
		r := replyReader{read: func(time.Duration) ([]byte, error) {
			if len(chunks) == 0 {
				return nil, errors.New("no input")
			}
			b := chunks[0]
			chunks = chunks[1:]
			return b, nil
		}}
		for _, expected := range []string{"pending", "sent"} {
			data, err := r.wait(context.Background(), "reply", "mine", time.Now().Add(time.Second))
			if err != nil || !strings.Contains(string(data), expected) {
				t.Fatalf("split %d: %s %v", split, data, err)
			}
		}
	}
}
func TestReplyTimeoutInterruptAndInputBound(t *testing.T) {
	r := replyReader{read: func(time.Duration) ([]byte, error) { return nil, nil }}
	if _, err := r.wait(context.Background(), "capabilities", "x", time.Now()); err == nil {
		t.Fatal("missing timeout")
	}
	for _, data := range []string{"\x03", "\x1b]" + strings.Repeat("x", 1024*1024)} {
		r := replyReader{read: func(time.Duration) ([]byte, error) { return []byte(data), nil }}
		if _, err := r.wait(context.Background(), "reply", "x", time.Now().Add(time.Second)); err == nil {
			t.Fatal("unbounded or uninterruptible reader")
		}
	}
}
