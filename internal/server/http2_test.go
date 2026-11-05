package server

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"tessera/internal/localhttps"
	"tessera/internal/store"
	"tessera/internal/terminalcore"
)

// startLocalHTTPS starts a server with Local HTTPS on an ephemeral port and
// returns it with a pool trusting its generated root.
func startLocalHTTPS(t *testing.T, opts Options) (*Server, *x509.CertPool) {
	t.Helper()
	databasePath := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := store.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	config := localhttps.Config{
		Enabled: true, HTTPSAddress: "127.0.0.1:0",
		DNSNames: []string{"localhost"}, IPAddresses: []string{"127.0.0.1"},
	}
	if err := st.SaveLocalHTTPSConfig(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	opts.Addr = "127.0.0.1:0"
	opts.DBPath = databasePath
	srv, err := Start(context.Background(), opts)
	if err != nil {
		t.Fatalf("start HTTPS server: %v", err)
	}
	t.Cleanup(func() { _ = srv.Shutdown(context.Background()) })
	rootPEM, err := localhttps.ReadRootPEM(srv.store.PKIFiles())
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootPEM) {
		t.Fatal("could not trust generated root")
	}
	return srv, roots
}

func TestHTTPSOffersHTTP2AndKeepsHTTP1(t *testing.T) {
	srv, roots := startLocalHTTPS(t, Options{})
	for _, test := range []struct {
		name       string
		forceHTTP2 bool
		wantMajor  int
	}{
		{"h2 client", true, 2},
		{"HTTP/1.1-only client", false, 1},
	} {
		client := &http.Client{Transport: &http.Transport{
			ForceAttemptHTTP2: test.forceHTTP2,
			TLSClientConfig:   &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12},
		}}
		response, err := client.Get(srv.HTTPSURL + "/api/health")
		if err != nil {
			t.Fatalf("%s: health request: %v", test.name, err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK || response.ProtoMajor != test.wantMajor {
			t.Fatalf("%s: health = %d over %s, want 200 over HTTP/%d", test.name, response.StatusCode, response.Proto, test.wantMajor)
		}
	}
}

// A reverse proxy that talks HTTP/2 to Tessera's HTTPS listener still has to
// carry the terminal websocket, which Go's transport sends on its own
// HTTP/1.1 connection because Tessera doesn't advertise extended CONNECT.
func TestReverseProxyOverHTTP2CarriesTerminalWebSocket(t *testing.T) {
	srv, roots := startLocalHTTPS(t, Options{TrustedProxies: []string{"127.0.0.1"}})
	upstream, err := url.Parse(srv.HTTPSURL)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	protocols := map[string]string{}
	proxy := &httputil.ReverseProxy{
		Transport: &http.Transport{
			ForceAttemptHTTP2: true,
			TLSClientConfig:   &tls.Config{RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12},
		},
		Rewrite: func(request *httputil.ProxyRequest) {
			request.SetURL(upstream)
			request.Out.Host = request.In.Host
			request.SetXForwarded()
		},
		ModifyResponse: func(response *http.Response) error {
			mu.Lock()
			protocols[response.Request.URL.Path] = response.Proto
			mu.Unlock()
			return nil
		},
	}
	front := httptest.NewServer(proxy)
	defer front.Close()

	response, err := http.Get(front.URL + "/api/health")
	if err != nil {
		t.Fatalf("proxied health request: %v", err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("proxied health status = %d, want 200", response.StatusCode)
	}

	query := "workspaceId=default&paneId=proxied&cols=80&rows=24&protocol=2&core=" + terminalcore.Compatibility
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(front.URL, "http")+"/api/terminal?"+query,
		http.Header{"Origin": []string{front.URL}})
	if err != nil {
		t.Fatalf("terminal websocket through the proxy: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	kind, data, err := conn.ReadMessage()
	var message struct{ Type string }
	if err != nil || kind != websocket.TextMessage || json.Unmarshal(data, &message) != nil || message.Type != "attach" {
		t.Fatalf("first terminal message = kind %d %q, err %v; want attach", kind, data, err)
	}

	mu.Lock()
	defer mu.Unlock()
	if protocols["/api/health"] != "HTTP/2.0" {
		t.Fatalf("proxy reached Tessera over %q for /api/health, want HTTP/2.0", protocols["/api/health"])
	}
	if protocols["/api/terminal"] != "HTTP/1.1" {
		t.Fatalf("proxy upgraded the terminal over %q, want HTTP/1.1", protocols["/api/terminal"])
	}
}
