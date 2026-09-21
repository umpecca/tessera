package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"tessera/internal/localhttps"
	"tessera/internal/store"
)

const testDesktopToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestDesktopRequestPolicy(t *testing.T) {
	for _, tc := range []struct {
		name, path, host, peer, origin, token string
		want                                  int
	}{
		{"workspace", "/api/health", "127.0.0.1:4321", "127.0.0.1:12", "", testDesktopToken, 200},
		{"no credential", "/api/health", "127.0.0.1:4321", "127.0.0.1:12", "", "", 403},
		{"wrong credential", "/api/health", "127.0.0.1:4321", "127.0.0.1:12", "", "wrong", 403},
		{"wrong host", "/api/health", "evil.example:4321", "127.0.0.1:12", "", testDesktopToken, 403},
		{"remote peer", "/api/health", "127.0.0.1:4321", "192.0.2.1:12", "", testDesktopToken, 403},
		{"other local port", "/api/health", "127.0.0.1:4321", "127.0.0.1:12", "http://127.0.0.1:9999", testDesktopToken, 403},
		{"opaque API", "/api/file", "127.0.0.1:4321", "127.0.0.1:12", "null", testDesktopToken, 403},
		{"opaque proxy", "/browser-proxy/example/", "127.0.0.1:4321", "127.0.0.1:12", "null", testDesktopToken, 200},
		{"HTTPS", "/api/host/https", "127.0.0.1:4321", "127.0.0.1:12", "", testDesktopToken, 403},
		{"certificate", "/api/host/https/ca", "127.0.0.1:4321", "127.0.0.1:12", "", testDesktopToken, 403},
		{"enrollment", "/local-https/", "127.0.0.1:4321", "127.0.0.1:12", "", testDesktopToken, 403},
		{"update", "/api/update", "127.0.0.1:4321", "127.0.0.1:12", "", testDesktopToken, 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Cookie") != "" {
					t.Error("credential passed to application handler")
				}
				w.Header().Set("Content-Security-Policy", "default-src *")
				_, _ = io.WriteString(w, "ok")
			})
			r := httptest.NewRequest("GET", "http://"+tc.host+tc.path, nil)
			r.RemoteAddr = tc.peer
			r.Header.Set("Origin", tc.origin)
			if tc.token != "" {
				r.AddCookie(&http.Cookie{Name: DesktopCookie, Value: tc.token})
			}
			w := httptest.NewRecorder()
			desktopHandler(next, "127.0.0.1:4321", testDesktopToken).ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status %d, want %d", w.Code, tc.want)
			}
			if tc.name == "opaque proxy" && !strings.Contains(w.Header().Get("Content-Security-Policy"), "sandbox allow-scripts") {
				t.Fatal("proxy did not receive desktop sandbox policy")
			}
		})
	}
}

func TestDesktopIgnoresSavedHTTPSAndRejectsReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "desktop.sqlite3")
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.SaveLocalHTTPSConfig(context.Background(), localhttps.Config{
		Enabled: true, HTTPSAddress: "0.0.0.0:7332", DNSNames: []string{"localhost"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	srv, err := Start(context.Background(), Options{Addr: "127.0.0.1:0", DBPath: path, DesktopToken: testDesktopToken})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Shutdown(context.Background())
	if srv.HTTPSAddr != "" || srv.HTTPSURL != "" {
		t.Fatal("desktop opened HTTPS")
	}
	if err := srv.ReloadLocalHTTPS(context.Background()); err == nil {
		t.Fatal("desktop allowed listener reload")
	}
	for _, authenticated := range []bool{false, true} {
		req, _ := http.NewRequest("GET", srv.URL+"/api/health", nil)
		if authenticated {
			req.AddCookie(&http.Cookie{Name: DesktopCookie, Value: testDesktopToken})
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		want := 403
		if authenticated {
			want = 200
		}
		if resp.StatusCode != want {
			t.Fatalf("health: %d, want %d", resp.StatusCode, want)
		}
	}
}

func TestDesktopRejectsUnsafeOptionsBeforeOpeningStore(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:0", "[::]:0", "localhost:0", "192.0.2.1:0"} {
		_, err := Start(context.Background(), Options{Addr: addr, DesktopToken: testDesktopToken})
		if err == nil || !strings.Contains(err.Error(), "127.0.0.1") {
			t.Fatalf("%s: %v", addr, err)
		}
	}
	for _, opts := range []Options{
		{Addr: "127.0.0.1:0", DesktopToken: "short"},
		{Addr: "127.0.0.1:0", DesktopToken: testDesktopToken, WebDir: "web"},
		{Addr: "127.0.0.1:0", DesktopToken: testDesktopToken, TrustedProxies: []string{"127.0.0.1"}},
	} {
		if _, err := Start(context.Background(), opts); err == nil {
			t.Fatal("unsafe options accepted")
		}
	}
}

func TestDesktopProxyRetainsWebSocketUpgrade(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		_ = conn.WriteMessage(websocket.TextMessage, []byte("hello"))
	})
	srv := httptest.NewUnstartedServer(nil)
	srv.Config.Handler = desktopHandler(inner, srv.Listener.Addr().String(), testDesktopToken)
	srv.Start()
	defer srv.Close()
	headers := http.Header{"Cookie": {DesktopCookie + "=" + testDesktopToken}, "Origin": {"null"}}
	conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http")+"/browser-proxy/test/", headers)
	if err != nil {
		t.Fatalf("upgrade: %v (%v)", err, resp)
	}
	defer conn.Close()
	_, message, err := conn.ReadMessage()
	if err != nil || string(message) != "hello" {
		t.Fatalf("message %q: %v", message, err)
	}
}

func TestDesktopProxyFlushesBeforeHandlerCompletes(t *testing.T) {
	release := make(chan struct{})
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "first\n")
		w.(http.Flusher).Flush()
		<-release
	})
	srv := httptest.NewUnstartedServer(nil)
	srv.Config.Handler = desktopHandler(inner, srv.Listener.Addr().String(), testDesktopToken)
	srv.Start()
	defer srv.Close()
	defer close(release)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/browser-proxy/test/", nil)
	req.AddCookie(&http.Cookie{Name: DesktopCookie, Value: testDesktopToken})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data := make([]byte, 6)
	if _, err := io.ReadFull(resp.Body, data); err != nil {
		t.Fatal(err)
	}
	if string(data) != "first\n" {
		t.Fatalf("streamed %q", data)
	}
}

func TestDesktopShutdownClosesAudioEventsWithoutWaitingForDeadline(t *testing.T) {
	srv, err := Start(context.Background(), Options{
		Addr: "127.0.0.1:0", DBPath: filepath.Join(t.TempDir(), "desktop.sqlite3"), DesktopToken: testDesktopToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/api/audio/events", nil)
	req.AddCookie(&http.Cookie{Name: DesktopCookie, Value: testDesktopToken})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		srv.Shutdown(context.Background())
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("SSE status: %d", resp.StatusCode)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown with active SSE: %v", err)
	}
	if _, err := io.ReadAll(resp.Body); err != nil {
		t.Fatalf("SSE did not close cleanly: %v", err)
	}
}

func TestDesktopSandboxProxyUsesScopedCapabilityWithoutAppCookie(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Cookie") != "" {
			t.Error("desktop cookie leaked upstream")
		}
		_, _ = io.WriteString(w, "local target")
	}))
	defer upstream.Close()
	srv, err := Start(context.Background(), Options{
		Addr: "127.0.0.1:0", DBPath: filepath.Join(t.TempDir(), "desktop.sqlite3"), DesktopToken: testDesktopToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Shutdown(context.Background())
	create, _ := http.NewRequest("POST", srv.URL+"/api/browser-proxy", strings.NewReader(`{"target":"`+upstream.URL+`"}`))
	create.AddCookie(&http.Cookie{Name: DesktopCookie, Value: testDesktopToken})
	created, err := http.DefaultClient.Do(create)
	if err != nil {
		t.Fatal(err)
	}
	var session struct {
		Path string `json:"path"`
	}
	decodeErr := json.NewDecoder(created.Body).Decode(&session)
	created.Body.Close()
	if created.StatusCode != http.StatusCreated || decodeErr != nil {
		t.Fatalf("create: %d %v", created.StatusCode, decodeErr)
	}
	for _, method := range []string{"GET", "OPTIONS"} {
		req, _ := http.NewRequest(method, srv.URL+session.Path, nil)
		req.Header.Set("Origin", "null")
		if method == "OPTIONS" {
			req.Header.Set("Access-Control-Request-Method", "POST")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		want := http.StatusOK
		if method == "OPTIONS" {
			want = http.StatusNoContent
		}
		if resp.StatusCode != want {
			t.Fatalf("%s: %d %s", method, resp.StatusCode, body)
		}
		if method == "GET" && string(body) != "local target" {
			t.Fatalf("proxy response %q", body)
		}
	}
	unknown, err := http.Get(srv.URL + "/browser-proxy/" + strings.Repeat("0", 48) + "/")
	if err != nil {
		t.Fatal(err)
	}
	unknown.Body.Close()
	if unknown.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown capability: %d", unknown.StatusCode)
	}
}
