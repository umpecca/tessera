package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalcore"
)

func TestPhoneSocketWatchesAndGivesBackASizeItTook(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real local PTY and WebSocket")
	}
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell")
	}
	t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "size.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	t.Cleanup(server.Close)
	size := func() [2]int {
		for _, summary := range manager.Summaries("default") {
			return [2]int{summary.Cols, summary.Rows}
		}
		return [2]int{}
	}
	waitSize := func(want [2]int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for size() != want {
			if time.Now().After(deadline) {
				t.Fatalf("size = %v, want %v", size(), want)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	query := "workspaceId=default&paneId=sized&protocol=2&core=" + terminalcore.Compatibility
	desk, _ := terminalTestSocket(t, server.URL, query+"&cols=100&rows=30")
	waitSize([2]int{100, 30})

	// With the desk's socket gone, a phone watching still doesn't take the
	// size, as the first socket to attach otherwise would.
	desk.Close()
	time.Sleep(100 * time.Millisecond)
	phone, _ := terminalTestSocket(t, server.URL, query+"&cols=45&rows=20&watch=1")
	time.Sleep(100 * time.Millisecond)
	waitSize([2]int{100, 30})

	if err := phone.WriteJSON(terminalClientMessage{Type: "resize", Cols: 45, Rows: 20, CellWidth: 8, CellHeight: 16, Temporary: true}); err != nil {
		t.Fatal(err)
	}
	waitSize([2]int{45, 20})
	if err := phone.WriteJSON(terminalClientMessage{Type: "release-size"}); err != nil {
		t.Fatal(err)
	}
	waitSize([2]int{100, 30})

	if err := phone.WriteJSON(terminalClientMessage{Type: "resize", Cols: 50, Rows: 22, CellWidth: 8, CellHeight: 16, Temporary: true}); err != nil {
		t.Fatal(err)
	}
	waitSize([2]int{50, 22})
	phone.Close()
	waitSize([2]int{100, 30})
}
