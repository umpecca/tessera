package httpapi

import (
	"bytes"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/gorilla/websocket"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/terminalcore"
)

func TestTerminalSocketNegotiatesCompression(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "compression.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	manager := terminal.NewManager()
	t.Cleanup(manager.Close)
	api := &API{Store: st, Terminals: manager}
	server := httptest.NewServer(http.HandlerFunc(api.terminalSession))
	t.Cleanup(server.Close)

	dialer := websocket.Dialer{EnableCompression: true}
	query := "workspaceId=default&paneId=compression&cols=80&rows=24&protocol=2&core=" + terminalcore.Compatibility
	conn, response, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?"+query, http.Header{"Origin": []string{server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if extensions := response.Header.Get("Sec-WebSocket-Extensions"); !strings.Contains(extensions, "permessage-deflate") {
		t.Fatalf("terminal socket did not negotiate compression: %q", extensions)
	}
}

// countingConn records the bytes that actually cross the wire, which is the
// only place compression is visible: the client inflates transparently.
type countingConn struct {
	net.Conn
	read *atomic.Int64
}

func (c countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.read.Add(int64(n))
	return n, err
}

func TestWriteTerminalBinaryCompressesOnlyLargeFrames(t *testing.T) {
	frames := make(chan []byte, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{EnableCompression: true}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		conn.EnableWriteCompression(false)
		for frame := range frames {
			if err := writeTerminalBinary(conn, frame); err != nil {
				t.Error(err)
				return
			}
		}
		_, _, _ = conn.ReadMessage()
	}))
	defer server.Close()

	var wire atomic.Int64
	dialer := websocket.Dialer{
		EnableCompression: true,
		NetDialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
			if err != nil {
				return nil, err
			}
			return countingConn{Conn: conn, read: &wire}, nil
		},
	}
	conn, _, err := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	receive := func(frame []byte) int64 {
		t.Helper()
		before := wire.Load()
		frames <- frame
		kind, data, err := conn.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || !bytes.Equal(data, frame) {
			t.Fatalf("frame did not round-trip: kind=%d err=%v", kind, err)
		}
		return wire.Load() - before
	}

	echo := []byte("\x1b[?2004l\ra\x1b[?2004h")
	if got := receive(echo); got != int64(len(echo))+2 {
		t.Errorf("small frame used %d wire bytes, want %d uncompressed", got, len(echo)+2)
	}
	output := bytes.Repeat([]byte("[ 12/400] \x1b[32mCompiling\x1b[0m crate v0.1.0\r\n"), 200)
	if got := receive(output); got*4 > int64(len(output)) {
		t.Errorf("large frame used %d wire bytes for %d bytes of output; expected compression", got, len(output))
	}
	close(frames)
}
