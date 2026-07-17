package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"tessera/internal/store"
)

func TestClientConnectionLogDeduplicatesFingerprints(t *testing.T) {
	var output bytes.Buffer
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{ConnectionLog: &output})

	request := func(remote, userAgent string) {
		req := httptest.NewRequest(http.MethodGet, "http://localhost:7331/api/health", nil)
		req.RemoteAddr = remote
		req.Header.Set("User-Agent", userAgent)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want 204", response.Code)
		}
	}

	request("192.0.2.10:1000", "private-browser-details")
	request("192.0.2.10:1001", "private-browser-details")
	request("192.0.2.10:1002", "different-browser")
	request("192.0.2.11:1000", "private-browser-details")

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 3 {
		t.Fatalf("connection log lines = %d, want 3: %q", len(lines), output.String())
	}
	if strings.Contains(output.String(), "private-browser-details") || strings.Contains(output.String(), "different-browser") {
		t.Fatalf("connection log exposed User-Agent: %q", output.String())
	}
	if !strings.Contains(lines[0], "client connected: ip=192.0.2.10 fingerprint=") || !strings.Contains(lines[2], "client connected: ip=192.0.2.11 fingerprint=") {
		t.Fatalf("unexpected connection log: %q", output.String())
	}
	for _, line := range lines {
		fingerprint := strings.TrimPrefix(strings.SplitAfter(line, "fingerprint=")[1], "fingerprint=")
		if len(fingerprint) != 12 {
			t.Fatalf("fingerprint length = %d, want 12: %q", len(fingerprint), line)
		}
	}
}

func TestClientConnectionLogIsConcurrentAndUsesTrustedProxyIP(t *testing.T) {
	prefixes, err := ParseTrustedProxies([]string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("parse trusted proxies: %v", err)
	}
	var output bytes.Buffer
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{TrustedProxies: prefixes, ConnectionLog: &output})

	var requests sync.WaitGroup
	for range 20 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			req := httptest.NewRequest(http.MethodGet, "http://localhost:7331/api/health", nil)
			req.RemoteAddr = "127.0.0.1:49152"
			req.Header.Set("X-Forwarded-For", "203.0.113.9")
			req.Header.Set("User-Agent", "same-browser")
			handler.ServeHTTP(httptest.NewRecorder(), req)
		}()
	}
	requests.Wait()

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 || !strings.Contains(lines[0], "client connected: ip=203.0.113.9 fingerprint=") {
		t.Fatalf("connection log = %q", output.String())
	}
}

func TestSecurityHeadersAndDirectIPOrigins(t *testing.T) {
	called := 0
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{})

	tests := []struct {
		name   string
		target string
		origin string
		want   int
	}{
		{name: "IPv4 intranet", target: "http://192.168.10.20:7331/api/run", origin: "http://192.168.10.20:7331", want: http.StatusNoContent},
		{name: "IPv6 intranet", target: "http://[fd00::20]:7331/api/run", origin: "http://[fd00::20]:7331", want: http.StatusNoContent},
		{name: "cross origin", target: "http://192.168.10.20:7331/api/run", origin: "http://attacker.example", want: http.StatusForbidden},
		{name: "non-browser local client", target: "http://127.0.0.1:7331/api/run", want: http.StatusNoContent},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, test.target, nil)
			req.RemoteAddr = "192.168.10.30:49152"
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, req)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.want, response.Body.String())
			}
			if response.Header().Get("Content-Security-Policy") == "" || response.Header().Get("X-Content-Type-Options") != "nosniff" || response.Header().Get("X-Frame-Options") != "DENY" {
				t.Fatalf("security headers missing: %v", response.Header())
			}
			if response.Header().Get("Strict-Transport-Security") != "" {
				t.Fatal("HSTS was emitted for direct HTTP")
			}
			if response.Header().Get("X-Request-ID") == "" {
				t.Fatal("X-Request-ID is missing")
			}
		})
	}
	if called != 3 {
		t.Fatalf("downstream call count = %d, want 3", called)
	}
}

func TestContentSecurityPolicyAllowsWASMWithoutGeneralEval(t *testing.T) {
	policy := contentSecurityPolicy(requestSecurity{
		scheme: "http",
		host:   "127.0.0.1:7331",
	})
	if !strings.Contains(policy, "script-src 'self' 'wasm-unsafe-eval'") {
		t.Fatalf("CSP does not permit terminal WebAssembly compilation: %q", policy)
	}
	if strings.Contains(policy, "'unsafe-eval'") {
		t.Fatalf("CSP permits general JavaScript eval: %q", policy)
	}
	if !strings.Contains(policy, "connect-src 'self' ws://127.0.0.1:7331 data:") {
		t.Fatalf("CSP does not permit the terminal's embedded WASM data URL: %q", policy)
	}
}

func TestTrustedProxyControlsEffectiveOriginAndClient(t *testing.T) {
	prefixes, err := ParseTrustedProxies([]string{"127.0.0.1/32"})
	if err != nil {
		t.Fatalf("parse trusted proxies: %v", err)
	}
	var got requestSecurity
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Context().Value(requestSecurityKey{}).(requestSecurity)
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{TrustedProxies: prefixes})
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:7331/api/run", nil)
	req.RemoteAddr = "127.0.0.1:49152"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.Header.Set("X-Forwarded-Host", "tessera.example")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Origin", "https://tessera.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
	}
	if got.clientIP != "203.0.113.9" || got.scheme != "https" || got.host != "tessera.example" {
		t.Fatalf("effective request = %+v", got)
	}
	if response.Header().Get("Strict-Transport-Security") != "max-age=86400" {
		t.Fatalf("HSTS = %q", response.Header().Get("Strict-Transport-Security"))
	}
	if csp := response.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "connect-src 'self' wss://tessera.example data:;") {
		t.Fatalf("CSP does not restrict WebSockets to the effective host: %q", csp)
	}
}

func TestUntrustedProxyHeadersAreIgnored(t *testing.T) {
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := r.Context().Value(requestSecurityKey{}).(requestSecurity)
		if info.clientIP != "192.168.1.9" || info.scheme != "http" || info.host != "192.168.1.5:7331" {
			t.Fatalf("effective request = %+v", info)
		}
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{})
	req := httptest.NewRequest(http.MethodPost, "http://192.168.1.5:7331/api/run", nil)
	req.RemoteAddr = "192.168.1.9:49152"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 203.0.113.10")
	req.Header.Set("X-Forwarded-Proto", "https")
	req.Header.Set("Origin", "http://192.168.1.5:7331")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("untrusted proxy caused HSTS")
	}
}

func TestTrustedProxyRejectsAmbiguousForwarding(t *testing.T) {
	prefixes, err := ParseTrustedProxies([]string{"127.0.0.1"})
	if err != nil {
		t.Fatalf("parse trusted proxies: %v", err)
	}
	handler := NewSecurityHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("downstream handler was called")
	}), nil, SecurityOptions{TrustedProxies: prefixes})
	req := httptest.NewRequest(http.MethodGet, "http://localhost:7331/api/health", nil)
	req.RemoteAddr = "127.0.0.1:49152"
	req.Header.Set("X-Forwarded-For", "203.0.113.9, 203.0.113.10")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestForwardedHeaderUsesSingleTrustedHop(t *testing.T) {
	prefixes, err := ParseTrustedProxies([]string{"10.0.0.0/8"})
	if err != nil {
		t.Fatalf("parse trusted proxies: %v", err)
	}
	var got requestSecurity
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Context().Value(requestSecurityKey{}).(requestSecurity)
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{TrustedProxies: prefixes})
	req := httptest.NewRequest(http.MethodPost, "http://10.0.0.2:7331/api/run", nil)
	req.RemoteAddr = "10.0.0.2:49152"
	req.Header.Set("Forwarded", `for="[2001:db8::7]";proto=https;host="tessera.example:443"`)
	req.Header.Set("Origin", "https://tessera.example")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204: %s", response.Code, response.Body.String())
	}
	if got.clientIP != "2001:db8::7" || got.scheme != "https" || got.host != "tessera.example:443" {
		t.Fatalf("effective request = %+v", got)
	}
}

func TestRateLimiterIsPerClientAndReturnsJSON(t *testing.T) {
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), nil, SecurityOptions{RatePerMinute: 60, RateBurst: 1})
	request := func(remote string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://localhost:7331/api/health", nil)
		req.RemoteAddr = remote
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}
	if got := request("192.0.2.1:1000"); got.Code != http.StatusNoContent {
		t.Fatalf("first status = %d", got.Code)
	}
	limited := request("192.0.2.1:1001")
	if limited.Code != http.StatusTooManyRequests || limited.Header().Get("Retry-After") != "1" || !strings.Contains(limited.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("limited response = %d, headers %v, body %q", limited.Code, limited.Header(), limited.Body.String())
	}
	if got := request("192.0.2.2:1000"); got.Code != http.StatusNoContent {
		t.Fatalf("other-client status = %d", got.Code)
	}
}

func TestClientRateLimiterRemovesInactiveEntries(t *testing.T) {
	limiter := newClientRateLimiter(60, 1)
	now := time.Now()
	if !limiter.allow("old", now.Add(-20*time.Minute)) {
		t.Fatal("first old request was denied")
	}
	limiter.lastCleanup = now.Add(-2 * time.Minute)
	if !limiter.allow("current", now) {
		t.Fatal("current request was denied")
	}
	if _, exists := limiter.clients["old"]; exists {
		t.Fatal("inactive limiter entry was not removed")
	}
}

func TestAuditMiddlewareStoresOnlyRedactedRequestMetadata(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "security-audit.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusCreated)
	}), st, SecurityOptions{AuditEnabled: true, AuditRetention: 30 * 24 * time.Hour})
	req := httptest.NewRequest(http.MethodPost, "http://localhost:7331/api/run?token=secret-path", strings.NewReader("command=secret-command"))
	req.RemoteAddr = "192.0.2.44:49152"
	req.Header.Set("Cookie", "session=secret-cookie")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", response.Code)
	}
	events, err := st.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("audit event count = %d, want 1", len(events))
	}
	event := events[0]
	if event.ClientIP != "192.0.2.44" || event.Method != http.MethodPost || event.Path != "/api/run" || event.Status != http.StatusCreated || event.Outcome != "success" {
		t.Fatalf("audit event = %+v", event)
	}
	encoded := strings.Join([]string{event.RequestID, event.ClientIP, event.Method, event.Path, event.Outcome}, " ")
	for _, secret := range []string{"secret-path", "secret-command", "secret-cookie"} {
		if strings.Contains(encoded, secret) {
			t.Fatalf("audit event contains %q: %+v", secret, event)
		}
	}
}

func TestAuditMiddlewareIsDisabledByDefault(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "security-audit-off.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), st, SecurityOptions{AuditRetention: 30 * 24 * time.Hour})
	req := httptest.NewRequest(http.MethodPost, "http://localhost:7331/api/run", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", response.Code)
	}
	events, err := st.ListAuditEvents(ctx, 10)
	if err != nil {
		t.Fatalf("list audit events: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("audit event count = %d, want 0", len(events))
	}
}

func TestStatusResponseWriterPreservesStreamingAndUpgradeInterfaces(t *testing.T) {
	underlying := &interfaceResponseWriter{header: make(http.Header)}
	tracked := &statusResponseWriter{ResponseWriter: underlying, status: http.StatusOK}
	tracked.Flush()
	if !underlying.flushed || tracked.status != http.StatusOK {
		t.Fatalf("flush was not preserved: underlying=%+v status=%d", underlying, tracked.status)
	}
	if _, _, err := tracked.Hijack(); err != nil {
		t.Fatalf("hijack: %v", err)
	}
	if !underlying.hijacked || tracked.status != http.StatusSwitchingProtocols {
		t.Fatalf("hijack was not preserved: underlying=%+v status=%d", underlying, tracked.status)
	}
}

type interfaceResponseWriter struct {
	header   http.Header
	flushed  bool
	hijacked bool
}

func (w *interfaceResponseWriter) Header() http.Header             { return w.header }
func (w *interfaceResponseWriter) Write(value []byte) (int, error) { return len(value), nil }
func (w *interfaceResponseWriter) WriteHeader(int)                 {}
func (w *interfaceResponseWriter) Flush()                          { w.flushed = true }
func (w *interfaceResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	left, right := net.Pipe()
	_ = right.Close()
	return left, bufio.NewReadWriter(bufio.NewReader(left), bufio.NewWriter(left)), nil
}
