package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/rdpsession"
)

// viewerPair returns a wsViewer on the server end of a WebSocket and the
// browser's end.
func viewerPair(t *testing.T) (*wsViewer, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		accepted <- conn
	}))
	t.Cleanup(server.Close)
	browser, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = browser.Close() })
	viewer := newWSViewer(<-accepted)
	t.Cleanup(viewer.stop)
	return viewer, browser
}

// behindReports runs the viewer's reportLoop and returns what it reported so far.
func behindReports(viewer *wsViewer) func() []bool {
	var mu sync.Mutex
	var reports []bool
	go viewer.reportLoop(func(behind bool) {
		mu.Lock()
		reports = append(reports, behind)
		mu.Unlock()
	})
	return func() []bool {
		mu.Lock()
		defer mu.Unlock()
		return append([]bool(nil), reports...)
	}
}

func waitForReports(t *testing.T, reports func() []bool, want ...bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !equalBools(reports(), want) {
		if time.Now().After(deadline) {
			t.Fatalf("reports = %v, want %v", reports(), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func equalBools(a, b []bool) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestASlowViewerIsBehindUntilItsFramesAreSent(t *testing.T) {
	viewer, browser := viewerPair(t)
	reports := behindReports(viewer)
	// Nothing is written yet, as when the network is slow: the frames wait.
	for range rdpKeptViewerBehindFrames - 1 {
		viewer.enqueue([]byte{2, 0})
	}
	time.Sleep(20 * time.Millisecond)
	waitForReports(t, reports)
	viewer.enqueue([]byte{2, 0})
	waitForReports(t, reports, true)

	go viewer.writeLoop()
	for range rdpKeptViewerBehindFrames {
		readFrame(t, browser)
	}
	waitForReports(t, reports, true, false)
	select {
	case <-viewer.done:
		t.Fatal("a viewer behind was dropped")
	default:
	}
}

func TestAViewerIsBehindWithAMegabyteWaiting(t *testing.T) {
	viewer, _ := viewerPair(t)
	reports := behindReports(viewer)
	viewer.enqueue(make([]byte, rdpKeptViewerBehindBytes/2))
	time.Sleep(20 * time.Millisecond)
	waitForReports(t, reports)
	viewer.enqueue(make([]byte, rdpKeptViewerBehindBytes/2))
	waitForReports(t, reports, true)
}

func TestAViewerFarBehindIsDropped(t *testing.T) {
	viewer, _ := viewerPair(t)
	for range rdpKeptViewerBacklog + 1 {
		viewer.enqueue([]byte{2, 0})
	}
	select {
	case <-viewer.done:
	case <-time.After(time.Second):
		t.Fatal("a viewer past the backlog wasn't dropped")
	}
}

func TestBrowserPressureSurvivesDrainingTheSocket(t *testing.T) {
	viewer, browser := viewerPair(t)
	reports := behindReports(viewer)
	for range rdpKeptViewerBehindFrames {
		viewer.enqueue([]byte{2, 0})
	}
	waitForReports(t, reports, true)
	if handled, err := viewer.handlePressure([]byte{rdpsession.ViewPressure, 1}); !handled || err != nil {
		t.Fatalf("browser pressure: handled=%v, error=%v", handled, err)
	}
	go viewer.writeLoop()
	for range rdpKeptViewerBehindFrames {
		readFrame(t, browser)
	}
	deadline := time.Now().Add(5 * time.Second)
	for viewer.behind.Load() || viewer.queued.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("socket backlog did not drain")
		}
		time.Sleep(time.Millisecond)
	}
	// Force a report-loop round trip while browser pressure is still set.
	viewer.pressureChanged()
	time.Sleep(20 * time.Millisecond)
	waitForReports(t, reports, true)
	viewer.handlePressure([]byte{rdpsession.ViewPressure, 0})
	waitForReports(t, reports, true, false)
}

func TestBrowserCatchingUpDoesNotClearNetworkPressure(t *testing.T) {
	viewer, _ := viewerPair(t)
	reports := behindReports(viewer)
	viewer.handlePressure([]byte{rdpsession.ViewPressure, 1})
	waitForReports(t, reports, true)
	viewer.setBehind(true)
	viewer.handlePressure([]byte{rdpsession.ViewPressure, 0})
	time.Sleep(20 * time.Millisecond)
	waitForReports(t, reports, true)
	viewer.setBehind(false)
	waitForReports(t, reports, true, false)
}

func TestViewerPressureMessagesAreValidated(t *testing.T) {
	viewer, _ := viewerPair(t)
	for _, message := range [][]byte{
		{rdpsession.ViewPressure},
		{rdpsession.ViewPressure, 2},
		{rdpsession.ViewPressure, 0, 0},
	} {
		if handled, err := viewer.handlePressure(message); !handled || !errors.Is(err, rdpsession.ErrViewerMessage) {
			t.Fatalf("pressure %v: handled=%v, error=%v", message, handled, err)
		}
		if viewer.browserBehind.Load() {
			t.Fatal("invalid pressure message changed the viewer")
		}
	}
	for _, message := range [][]byte{nil, {rdpsession.ViewInput, 6}, {rdpsession.ViewShown, 0}} {
		if handled, err := viewer.handlePressure(message); handled || err != nil {
			t.Fatalf("session message %v: handled=%v, error=%v", message, handled, err)
		}
	}
	viewer.handlePressure([]byte{rdpsession.ViewPressure, 1})
	next, _ := viewerPair(t)
	if next.browserBehind.Load() {
		t.Fatal("a new viewer inherited old browser pressure")
	}
}
