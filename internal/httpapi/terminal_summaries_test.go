package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalcore"

	"github.com/gorilla/websocket"
)

func getTerminalSummaries(t *testing.T, url string) terminalSummaries {
	t.Helper()
	response, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	var summaries terminalSummaries
	if err := json.NewDecoder(response.Body).Decode(&summaries); err != nil {
		t.Fatal(err)
	}
	return summaries
}

func TestWorkspaceTerminalsSummarizeAndWaitForChanges(t *testing.T) {
	if testing.Short() {
		t.Skip("uses a real local PTY and WebSocket")
	}
	if runtime.GOOS == "windows" {
		t.Skip("uses printf in a POSIX shell")
	}
	t.Setenv("TESSERA_TERMINAL_SHELL", "/bin/sh")
	terminalSummaryPoll = 20 * time.Millisecond
	terminalSummaryWait = 300 * time.Millisecond
	t.Cleanup(func() { terminalSummaryPoll, terminalSummaryWait = time.Second, 25*time.Second })
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "summaries.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.workspace))
	t.Cleanup(server.Close)
	terminals := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	t.Cleanup(terminals.Close)
	list := server.URL + "/api/workspace/default/terminals"

	if empty := getTerminalSummaries(t, list); len(empty.Terminals) != 0 || empty.Version == "" {
		t.Fatalf("no shells = %+v", empty)
	}
	query := "workspaceId=default&paneId=phone&cols=80&rows=24&protocol=2&core=" + terminalcore.Compatibility
	conn, _ := terminalTestSocket(t, terminals.URL, query)
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte("printf 'hello %s\\n' phone\r")); err != nil {
		t.Fatal(err)
	}
	var summaries terminalSummaries
	deadline := time.Now().Add(5 * time.Second)
	for {
		summaries = getTerminalSummaries(t, list)
		if len(summaries.Terminals) == 1 && slices.Contains(summaries.Terminals[0].Tail, "hello phone") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("summaries = %+v", summaries)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if summary := summaries.Terminals[0]; summary.PaneID != "phone" || summary.Cols != 80 || summary.Rows != 24 {
		t.Fatalf("summary = %+v", summary)
	}

	// Nothing changes: the request waits, then answers with the same version.
	started := time.Now()
	if same := getTerminalSummaries(t, list+"?version="+summaries.Version); same.Version != summaries.Version || time.Since(started) < terminalSummaryWait {
		t.Fatalf("unchanged answer %q after %s", same.Version, time.Since(started))
	}

	// Output while it waits answers it with the new screen.
	terminalSummaryWait = 5 * time.Second
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte("printf 'second %s\\n' line\r"))
	}()
	changed := getTerminalSummaries(t, list+"?version="+summaries.Version)
	if changed.Version == summaries.Version || !strings.Contains(strings.Join(changed.Terminals[0].Tail, "\n"), "second") {
		t.Fatalf("changed = %+v", changed)
	}

	post := httptest.NewRecorder()
	api.workspace(post, httptest.NewRequest(http.MethodPost, "/api/workspace/default/terminals", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", post.Code)
	}
}

func TestTerminalSummaryVersionIgnoresClocks(t *testing.T) {
	a := []terminal.Summary{{PaneID: "p", Running: true, RunningSeconds: 3, OutputSecondsAgo: 1, Tail: []string{"x"}}}
	b := []terminal.Summary{{PaneID: "p", Running: true, RunningSeconds: 9, OutputSecondsAgo: 7, Tail: []string{"x"}}}
	if terminalSummaryVersion(a) != terminalSummaryVersion(b) {
		t.Fatal("ticking clocks changed the version")
	}
	never := []terminal.Summary{{PaneID: "p", Running: true, OutputSecondsAgo: -1, Tail: []string{"x"}}}
	if terminalSummaryVersion(a) == terminalSummaryVersion(never) {
		t.Fatal("first output didn't change the version")
	}
	b[0].Tail = []string{"y"}
	if terminalSummaryVersion(a) == terminalSummaryVersion(b) {
		t.Fatal("new output didn't change the version")
	}
}
