package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/store"
)

func TestNormalizeVNCTarget(t *testing.T) {
	tests := map[string]string{
		"example.com":              "example.com:5900",
		"EXAMPLE.com:5901":         "example.com:5901",
		"vnc://desktop.local":      "desktop.local:5900",
		"192.0.2.10:5999":          "192.0.2.10:5999",
		"[2001:db8::1]":            "[2001:db8::1]:5900",
		"vnc://[2001:db8::1]:5902": "[2001:db8::1]:5902",
	}
	for raw, want := range tests {
		got, err := normalizeVNCTarget(raw)
		if err != nil {
			t.Errorf("normalizeVNCTarget(%q): %v", raw, err)
			continue
		}
		if got != want {
			t.Errorf("normalizeVNCTarget(%q) = %q, want %q", raw, got, want)
		}
	}
	for _, raw := range []string{"", "http://example.com", "host:0", "host:65536", "host:abc", "vnc://user:secret@host", "vnc://host/path", "2001:db8::1"} {
		if _, err := normalizeVNCTarget(raw); err == nil {
			t.Errorf("normalizeVNCTarget(%q) succeeded", raw)
		}
	}
}

func TestVNCCapabilityExpiresAndIsConsumedOnce(t *testing.T) {
	manager := &vncProxyManager{capabilities: make(map[string]vncCapability)}
	now := time.Now()
	id, err := manager.create("example.com:5900", now)
	if err != nil {
		t.Fatalf("create capability: %v", err)
	}
	if target, ok := manager.consume(id, now.Add(time.Minute)); !ok || target != "example.com:5900" {
		t.Fatalf("consume = %q, %v", target, ok)
	}
	if _, ok := manager.consume(id, now.Add(time.Minute)); ok {
		t.Fatal("capability was reusable")
	}
	expired, err := manager.create("example.com:5900", now)
	if err != nil {
		t.Fatalf("create expiring capability: %v", err)
	}
	if _, ok := manager.consume(expired, now.Add(vncCapabilityLife)); ok {
		t.Fatal("expired capability was accepted")
	}
}

func TestVNCProxyCreateChecksWorkspaceAndReturnsCanonicalTarget(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "vnc.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	if _, err := st.LoadDefaultWorkspace(context.Background(), ""); err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	api := &API{Store: st}
	request := httptest.NewRequest(http.MethodPost, "/api/vnc-proxy", strings.NewReader(`{"workspaceId":"default","target":"example.com"}`))
	response := httptest.NewRecorder()
	api.vncProxyCreate(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", response.Code, response.Body.String())
	}
	var created struct {
		Path   string `json:"path"`
		Target string `json:"target"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if created.Target != "example.com:5900" || !strings.HasPrefix(created.Path, "/api/vnc-proxy/connect?session=") {
		t.Fatalf("unexpected create response: %+v", created)
	}

	request = httptest.NewRequest(http.MethodPost, "/api/vnc-proxy", strings.NewReader(`{"workspaceId":"other","target":"example.com"}`))
	response = httptest.NewRecorder()
	api.vncProxyCreate(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown workspace status = %d", response.Code)
	}
}

func TestVNCProxyConnectRejectsOriginProtocolCapabilityAndDialFailure(t *testing.T) {
	api := &API{}

	request := httptest.NewRequest(http.MethodGet, "http://tessera.test/api/vnc-proxy/connect?session=missing", nil)
	request.Header.Set("Origin", "http://other.test")
	request.Header.Set("Sec-WebSocket-Protocol", "binary")
	response := httptest.NewRecorder()
	api.vncProxyConnect(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://tessera.test/api/vnc-proxy/connect?session=missing", nil)
	response = httptest.NewRecorder()
	api.vncProxyConnect(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("missing protocol status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "http://tessera.test/api/vnc-proxy/connect?session=missing", nil)
	request.Header.Set("Sec-WebSocket-Protocol", "binary")
	response = httptest.NewRecorder()
	api.vncProxyConnect(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("unknown capability status = %d", response.Code)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve failure address: %v", err)
	}
	target := listener.Addr().String()
	listener.Close()
	id, err := api.vncManager().create(target, time.Now())
	if err != nil {
		t.Fatalf("create capability: %v", err)
	}
	request = httptest.NewRequest(http.MethodGet, "http://tessera.test/api/vnc-proxy/connect?session="+id, nil)
	request.Header.Set("Sec-WebSocket-Protocol", "binary")
	response = httptest.NewRecorder()
	api.vncProxyConnect(response, request)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("dial failure status = %d: %s", response.Code, response.Body.String())
	}
	if _, ok := api.vncManager().consume(id, time.Now()); ok {
		t.Fatal("dial failure did not consume capability")
	}
}

func TestVNCProxyRelaysBinaryAndRejectsText(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer connection.Close()
				buffer := make([]byte, 1024)
				count, readErr := connection.Read(buffer)
				if readErr == nil {
					_, _ = connection.Write(append([]byte("echo:"), buffer[:count]...))
				}
			}()
		}
	}()

	api := &API{}
	server := httptest.NewServer(http.HandlerFunc(api.vncProxyConnect))
	defer server.Close()
	dial := func() *websocket.Conn {
		t.Helper()
		id, createErr := api.vncManager().create(listener.Addr().String(), time.Now())
		if createErr != nil {
			t.Fatalf("create capability: %v", createErr)
		}
		dialer := *websocket.DefaultDialer
		dialer.Subprotocols = []string{"binary"}
		header := http.Header{"Origin": []string{server.URL}}
		connection, response, dialErr := dialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?session="+id, header)
		if dialErr != nil {
			if response != nil {
				t.Fatalf("dial: %v (status %d)", dialErr, response.StatusCode)
			}
			t.Fatalf("dial: %v", dialErr)
		}
		if connection.Subprotocol() != "binary" {
			t.Fatalf("subprotocol = %q", connection.Subprotocol())
		}
		return connection
	}

	connection := dial()
	if err := connection.WriteMessage(websocket.BinaryMessage, []byte("hello")); err != nil {
		t.Fatalf("write binary: %v", err)
	}
	messageType, message, err := connection.ReadMessage()
	if err != nil {
		t.Fatalf("read binary: %v", err)
	}
	if messageType != websocket.BinaryMessage || !bytes.Equal(message, []byte("echo:hello")) {
		t.Fatalf("relay = type %d %q", messageType, message)
	}
	connection.Close()

	connection = dial()
	defer connection.Close()
	if err := connection.WriteMessage(websocket.TextMessage, []byte("not RFB")); err != nil {
		t.Fatalf("write text: %v", err)
	}
	_, _, err = connection.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != websocket.CloseUnsupportedData {
		t.Fatalf("text close error = %v", err)
	}
}
