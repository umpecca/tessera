package audio

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"tessera/internal/store"
)

type fakeTerminals struct {
	pid     int
	onClose func(string, string)
}

func (f *fakeTerminals) ProcessID(_, _ string) (int, bool) { return f.pid, f.pid > 0 }
func (f *fakeTerminals) SetCloseHandler(handler func(string, string)) {
	f.onClose = handler
}

func TestFileStationPersistsAndRestartsPaused(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "tessera.sqlite3")
	audioPath := filepath.Join(dir, "song.mp3")
	if err := os.WriteFile(audioPath, []byte("ID3test"), 0o644); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 7, 16, 12, 0, 0, 0, time.UTC)
	st, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(st, nil, Options{Now: func() time.Time { return now }})
	state, err := manager.SetSource(ctx, Source{Kind: SourceFile, Value: audioPath})
	if err != nil {
		t.Fatalf("set source: %v", err)
	}
	if !state.Seekable || state.SourceVersion != 1 || state.Status != StatusPaused {
		t.Fatalf("unexpected selected state: %+v", state)
	}
	if _, err := manager.Control(ctx, "play", 0); err != nil {
		t.Fatalf("play: %v", err)
	}
	now = now.Add(7 * time.Second)
	paused, err := manager.Control(ctx, "pause", 0)
	if err != nil {
		t.Fatalf("pause: %v", err)
	}
	if paused.PositionSeconds != 7 {
		t.Fatalf("position = %v, want 7", paused.PositionSeconds)
	}
	manager.Close()
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := store.Open(ctx, dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	restarted := NewManager(reopened, nil, Options{})
	defer restarted.Close()
	got := restarted.State()
	if got.Status != StatusPaused || got.PositionSeconds != 7 || got.Source == nil || got.Source.Value != audioPath {
		t.Fatalf("restarted state = %+v", got)
	}
}

func TestSourceReplacementInvalidatesStreamVersionAndPublishesState(t *testing.T) {
	manager := NewManager(nil, nil, Options{})
	defer manager.Close()
	initial, events, unsubscribe := manager.Subscribe()
	defer unsubscribe()
	if initial.Source != nil || initial.Status != StatusStopped {
		t.Fatalf("initial state = %+v", initial)
	}

	first, err := manager.SetSource(context.Background(), Source{Kind: SourceURL, Value: "https://radio.example.test/live.mp3"})
	if err != nil {
		t.Fatal(err)
	}
	streamContext, untrack, err := manager.TrackStream(context.Background(), first.SourceVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer untrack()
	second, err := manager.SetSource(context.Background(), Source{Kind: SourceURL, Value: "https://radio.example.test/next.ogg"})
	if err != nil {
		t.Fatal(err)
	}
	if second.SourceVersion != first.SourceVersion+1 || second.StateVersion <= first.StateVersion {
		t.Fatalf("versions did not advance: first=%+v second=%+v", first, second)
	}
	if _, _, err := manager.SourceForStream(first.SourceVersion); err == nil {
		t.Fatal("stale source version was accepted")
	}
	select {
	case <-streamContext.Done():
	case <-time.After(time.Second):
		t.Fatal("source replacement did not cancel the old listener")
	}
	select {
	case published := <-events:
		if published.SourceVersion == 0 {
			t.Fatalf("published state = %+v", published)
		}
	case <-time.After(time.Second):
		t.Fatal("state change was not published")
	}
}

func TestSourceValidationAndSeekBoundary(t *testing.T) {
	manager := NewManager(nil, nil, Options{})
	defer manager.Close()
	if _, err := manager.SetSource(context.Background(), Source{Kind: SourceFile, Value: "relative.mp3"}); err == nil {
		t.Fatal("relative host path was accepted")
	}
	if _, err := manager.SetSource(context.Background(), Source{Kind: SourceURL, Value: "file:///tmp/song.mp3"}); err == nil {
		t.Fatal("non-HTTP URL was accepted")
	}
	if _, err := manager.SetSource(context.Background(), Source{Kind: SourceURL, Value: "https://example.test/live.m3u8"}); err == nil {
		t.Fatal("HLS playlist was accepted")
	}
	if _, err := manager.SetSource(context.Background(), Source{Kind: SourceURL, Value: "https://example.test/live.mp3"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Control(context.Background(), "seek", 3); err == nil {
		t.Fatal("seek on URL source was accepted")
	}
}

func TestTerminalCaptureFansOutOnePipeline(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("terminal capture is unsupported on this platform")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(nil, &fakeTerminals{pid: os.Getpid()}, Options{
		CaptureHelper: executable,
		Encoder:       executable,
		ReadyTimeout:  2 * time.Second,
		captureArgs:   []string{"-test.run=TestCaptureProcess", "--"},
		encoderArgs:   []string{"-test.run=TestCaptureProcess", "--"},
		captureEnv:    []string{"TESSERA_CAPTURE_TEST_ROLE=helper"},
		encoderEnv:    []string{"TESSERA_CAPTURE_TEST_ROLE=encoder"},
	})
	defer manager.Close()
	state, err := manager.SetSource(context.Background(), Source{
		Kind: SourceTerminal, WorkspaceID: "workspace", PaneID: "pane",
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err = manager.Control(context.Background(), "play", 0)
	if err != nil {
		t.Fatalf("play terminal capture: %v", err)
	}
	if state.Status != StatusPlaying {
		t.Fatalf("state = %+v", state)
	}
	_, first, unsubscribeFirst, err := manager.SubscribeStream(state.SourceVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribeFirst()
	_, second, unsubscribeSecond, err := manager.SubscribeStream(state.SourceVersion)
	if err != nil {
		t.Fatal(err)
	}
	defer unsubscribeSecond()
	for index, stream := range []<-chan []byte{first, second} {
		select {
		case chunk := <-stream:
			if len(chunk) == 0 {
				t.Fatalf("listener %d received an empty chunk", index)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("listener %d did not receive encoded audio", index)
		}
	}
	if _, err := manager.Control(context.Background(), "pause", 0); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalCaptureReadyTimeoutFailsSoftly(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("terminal capture is unsupported on this platform")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	manager := NewManager(nil, &fakeTerminals{pid: os.Getpid()}, Options{
		CaptureHelper: executable,
		Encoder:       executable,
		ReadyTimeout:  100 * time.Millisecond,
		captureArgs:   []string{"-test.run=TestCaptureProcess", "--"},
		encoderArgs:   []string{"-test.run=TestCaptureProcess", "--"},
		captureEnv:    []string{"TESSERA_CAPTURE_TEST_ROLE=timeout"},
		encoderEnv:    []string{"TESSERA_CAPTURE_TEST_ROLE=encoder"},
	})
	defer manager.Close()
	if _, err := manager.SetSource(context.Background(), Source{Kind: SourceTerminal, WorkspaceID: "w", PaneID: "p"}); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Control(context.Background(), "play", 0); err == nil {
		t.Fatal("capture without a ready event started")
	}
	state := manager.State()
	if state.Status != StatusPaused || state.Error == "" {
		t.Fatalf("failed capture state = %+v", state)
	}
}

func TestCaptureProcess(t *testing.T) {
	role := os.Getenv("TESSERA_CAPTURE_TEST_ROLE")
	if role == "" {
		return
	}
	switch role {
	case "helper":
		_, _ = fmt.Fprintln(os.Stderr, `{"type":"ready"}`)
		for {
			if _, err := os.Stdout.Write([]byte("synthetic-pcm-frame")); err != nil {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
	case "timeout":
		time.Sleep(10 * time.Second)
	case "encoder":
		_, _ = io.Copy(os.Stdout, os.Stdin)
	default:
		os.Exit(2)
	}
	os.Exit(0)
}
