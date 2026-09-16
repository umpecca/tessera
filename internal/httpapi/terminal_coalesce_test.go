package httpapi

import (
	"bytes"
	"testing"
	"time"
)

func TestCoalesceTerminalFramesJoinsFramesUntilQuiet(t *testing.T) {
	events := make(chan []byte, 4)
	events <- []byte("b")
	events <- []byte("c")
	first := []byte("a")
	batch, open := coalesceTerminalFrames(first, events, 20*time.Millisecond, time.Second, 1024)
	if !open || !bytes.Equal(batch, []byte("abc")) {
		t.Fatalf("batch %q open=%v", batch, open)
	}
	if !bytes.Equal(first, []byte("a")) {
		t.Fatal("first frame was modified")
	}
}

func TestCoalesceTerminalFramesStopsAtHoldLimitAndClose(t *testing.T) {
	events := make(chan []byte)
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		for {
			select {
			case events <- []byte("x"):
				time.Sleep(time.Millisecond)
			case <-stop:
				return
			}
		}
	}()
	started := time.Now()
	batch, open := coalesceTerminalFrames([]byte("x"), events, 50*time.Millisecond, 20*time.Millisecond, 1<<20)
	if !open || time.Since(started) > 200*time.Millisecond || len(batch) < 2 {
		t.Fatalf("hold not enforced: %d bytes after %v", len(batch), time.Since(started))
	}
	if batch, _ := coalesceTerminalFrames([]byte("x"), events, 50*time.Millisecond, time.Second, 3); len(batch) != 3 {
		t.Fatalf("size limit not enforced: %d bytes", len(batch))
	}

	closed := make(chan []byte, 1)
	closed <- []byte("y")
	close(closed)
	if batch, open := coalesceTerminalFrames([]byte("x"), closed, time.Second, time.Second, 1024); open || string(batch) != "xy" {
		t.Fatalf("close: %q open=%v", batch, open)
	}
}
