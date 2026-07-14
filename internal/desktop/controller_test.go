package desktop

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"tessera/internal/server"
)

func TestControllerStartOnlyStartsOnce(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	starts := 0
	controller := newController(server.Options{}, func(context.Context, server.Options) (*server.Server, error) {
		mu.Lock()
		starts++
		mu.Unlock()
		return &server.Server{URL: "http://127.0.0.1:7331"}, nil
	}, func(string) error { return nil })

	if err := controller.Start(context.Background()); err != nil {
		t.Fatalf("first start: %v", err)
	}
	if err := controller.Start(context.Background()); err != nil {
		t.Fatalf("second start: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if starts != 1 {
		t.Fatalf("starts = %d, want 1", starts)
	}
}

func TestControllerStopsAndRestartsServer(t *testing.T) {
	controller := NewController(server.Options{
		Addr:   "127.0.0.1:0",
		DBPath: filepath.Join(t.TempDir(), "tessera.sqlite3"),
	})
	ctx := context.Background()

	if err := controller.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}
	firstURL := controller.URL()
	if firstURL == "" || !controller.Running() {
		t.Fatalf("server should be running at %q", firstURL)
	}
	if err := controller.Stop(ctx); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if controller.Running() {
		t.Fatal("server should be stopped")
	}
	if err := controller.Start(ctx); err != nil {
		t.Fatalf("restart: %v", err)
	}
	if err := controller.Stop(ctx); err != nil {
		t.Fatalf("final stop: %v", err)
	}
}

func TestControllerConfigureStartsAndOpensURL(t *testing.T) {
	t.Parallel()
	opened := ""
	controller := newController(server.Options{}, func(context.Context, server.Options) (*server.Server, error) {
		return &server.Server{URL: "http://127.0.0.1:7331"}, nil
	}, func(url string) error {
		opened = url
		return nil
	})

	if err := controller.Configure(context.Background()); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if opened != "http://127.0.0.1:7331" {
		t.Fatalf("opened = %q", opened)
	}
}
