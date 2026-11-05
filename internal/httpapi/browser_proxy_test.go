package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestBrowserProxyNormalizesAndRejectsNonLoopbackTargets(t *testing.T) {
	target, err := normalizeBrowserProxyTarget("localhost:5000/app?q=1#fragment")
	if err != nil {
		t.Fatalf("normalize target: %v", err)
	}
	if got := target.String(); got != "http://localhost:5000/app?q=1" {
		t.Fatalf("normalized target = %q", got)
	}
	if err := validateLoopbackHost(t.Context(), "127.0.0.1"); err != nil {
		t.Fatalf("validate loopback: %v", err)
	}
	if err := validateLoopbackHost(t.Context(), "192.0.2.10"); err == nil {
		t.Fatal("validateLoopbackHost accepted a non-loopback address")
	}
	for _, raw := range []string{"file:///tmp/page", "http://user:pass@localhost:5000", ""} {
		if _, err := normalizeBrowserProxyTarget(raw); err == nil {
			t.Errorf("normalizeBrowserProxyTarget(%q) succeeded", raw)
		}
	}
}

func TestBrowserProxyRewritesDevelopmentPageAndRedirect(t *testing.T) {
	var receivedOrigin, receivedCookie string
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedOrigin = r.Header.Get("Origin")
		receivedCookie = r.Header.Get("Cookie")
		switch r.URL.Path {
		case "/":
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Header().Set("Content-Security-Policy", "default-src 'none'")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Add("Set-Cookie", "target=value")
			_, _ = w.Write([]byte(`<!doctype html><head><link href="/style.css"></head><body><script type="module" src="/app.js"></script></body>`))
		case "/redirect":
			http.Redirect(w, r, "/next?q=1", http.StatusFound)
		default:
			_, _ = w.Write([]byte(r.URL.Path))
		}
	}))
	defer targetServer.Close()

	target, _ := url.Parse(targetServer.URL)
	session, err := newBrowserProxySession(target)
	if err != nil {
		t.Fatalf("new proxy session: %v", err)
	}
	api := &API{}
	api.proxyManager().add(session)

	request := httptest.NewRequest(http.MethodGet, browserProxyPrefix+session.id+"/", nil)
	request.Header.Set("Cookie", "tessera=secret")
	response := httptest.NewRecorder()
	response.Header().Set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'")
	api.browserProxyRequest(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("proxy status = %d: %s", response.Code, response.Body.String())
	}
	prefix := browserProxyPrefix + session.id
	body := response.Body.String()
	if strings.Contains(body, "<base") {
		t.Errorf("rewritten HTML has an injected <base>: %s", body)
	}
	for _, fragment := range []string{`href="` + prefix + `/style.css"`, `src="` + prefix + `/app.js"`, "tessera-browser-location", "tessera-browser-draw"} {
		if !strings.Contains(body, fragment) {
			t.Errorf("rewritten HTML does not contain %q: %s", fragment, body)
		}
	}
	if receivedOrigin != targetServer.URL {
		t.Errorf("target Origin = %q, want %q", receivedOrigin, targetServer.URL)
	}
	if receivedCookie != "" {
		t.Errorf("target received Tessera cookie %q", receivedCookie)
	}
	if response.Header().Get("Set-Cookie") != "" || response.Header().Get("X-Frame-Options") != "" {
		t.Errorf("unsafe target headers survived: %v", response.Header())
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Errorf("proxy CORS origin = %q", response.Header().Get("Access-Control-Allow-Origin"))
	}
	if policy := response.Header().Get("Content-Security-Policy"); strings.Contains(policy, "frame-ancestors") || strings.Contains(policy, ",") {
		t.Errorf("outer content security policy survived: %q", policy)
	} else if !strings.HasPrefix(policy, "sandbox ") || strings.Contains(policy, "allow-same-origin") {
		t.Errorf("proxied pages must stay sandboxed outside the pane iframe: %q", policy)
	}

	request = httptest.NewRequest(http.MethodGet, prefix+"/redirect", nil)
	response = httptest.NewRecorder()
	api.browserProxyRequest(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("redirect status = %d", response.Code)
	}
	if got := response.Header().Get("Location"); got != prefix+"/next?q=1" {
		t.Fatalf("rewritten redirect = %q", got)
	}
}

func TestBrowserProxyRevalidatesRewrittenResponses(t *testing.T) {
	page := `<!doctype html><head><link href="/style.css"></head><body>` + strings.Repeat("<p>content</p>", 100) + `</body>`
	var receivedValidator string
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedValidator = r.Header.Get("If-None-Match")
		w.Header().Set("Cache-Control", "no-cache")
		switch r.URL.Path {
		case "/":
			w.Header().Set("ETag", `"page-1"`)
			http.ServeContent(w, r, "index.html", time.Time{}, strings.NewReader(page))
		case "/app.js":
			w.Header().Set("ETag", `W/"module-1"`)
			http.ServeContent(w, r, "app.js", time.Time{}, strings.NewReader(`import "/dep.js";`))
		}
	}))
	defer targetServer.Close()
	target, _ := url.Parse(targetServer.URL)
	session, err := newBrowserProxySession(target)
	if err != nil {
		t.Fatalf("new proxy session: %v", err)
	}
	api := &API{}
	api.proxyManager().add(session)
	handler := NewCompressionHandler(http.HandlerFunc(api.browserProxyRequest))
	prefix := browserProxyPrefix + session.id
	fetch := func(path, validator string, gzip bool) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, prefix+path, nil)
		if validator != "" {
			request.Header.Set("If-None-Match", validator)
		}
		if gzip {
			request.Header.Set("Accept-Encoding", "gzip")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	// The page is rewritten and gzipped; its validator names both.
	first := fetch("/", "", true)
	pageTag := first.Header().Get("ETag")
	if first.Code != http.StatusOK || pageTag != `"page-1`+browserProxyETagSuffix+gzipETagSuffix+`"` {
		t.Fatalf("first page = %d with ETag %q", first.Code, pageTag)
	}
	again := fetch("/", pageTag, true)
	if again.Code != http.StatusNotModified || receivedValidator != `"page-1"` || again.Header().Get("ETag") != pageTag || again.Body.Len() != 0 {
		t.Fatalf("revalidated page = %d with ETag %q, body %d bytes; server saw %q", again.Code, again.Header().Get("ETag"), again.Body.Len(), receivedValidator)
	}

	// A copy rewritten by another Tessera doesn't match.
	stale := fetch("/", `"page-1-tessera-000000000000"`, false)
	if stale.Code != http.StatusOK || !strings.Contains(stale.Body.String(), prefix+"/style.css") {
		t.Fatalf("stale copy = %d, want a fresh rewritten page", stale.Code)
	}

	// A small module isn't gzipped, and a weak validator stays weak.
	module := fetch("/app.js", "", false)
	moduleTag := module.Header().Get("ETag")
	if module.Code != http.StatusOK || moduleTag != `W/"module-1`+browserProxyETagSuffix+`"` || !strings.Contains(module.Body.String(), prefix+"/dep.js") {
		t.Fatalf("module = %d with ETag %q: %s", module.Code, moduleTag, module.Body.String())
	}
	if again := fetch("/app.js", moduleTag, false); again.Code != http.StatusNotModified || again.Header().Get("ETag") != moduleTag {
		t.Fatalf("revalidated module = %d with ETag %q", again.Code, again.Header().Get("ETag"))
	}
}

func TestBrowserProxyResolvesRedirectsAgainstRequestedPath(t *testing.T) {
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/a/b/index.html":
			w.Header().Set("Location", "./?q=1")
			w.WriteHeader(http.StatusMovedPermanently)
		case "/a/b/fragment":
			w.Header().Set("Location", "next#part")
			w.WriteHeader(http.StatusFound)
		case "/away":
			w.Header().Set("Location", "http://192.0.2.10/")
			w.WriteHeader(http.StatusFound)
		}
	}))
	defer targetServer.Close()
	target, _ := url.Parse(targetServer.URL)
	session, err := newBrowserProxySession(target)
	if err != nil {
		t.Fatalf("new proxy session: %v", err)
	}
	api := &API{}
	api.proxyManager().add(session)
	prefix := browserProxyPrefix + session.id

	for path, want := range map[string]string{
		"/a/b/index.html": prefix + "/a/b/?q=1",
		"/a/b/fragment":   prefix + "/a/b/next#part",
	} {
		response := httptest.NewRecorder()
		api.browserProxyRequest(response, httptest.NewRequest(http.MethodGet, prefix+path, nil))
		if got := response.Header().Get("Location"); got != want {
			t.Errorf("redirect from %s = %q (status %d), want %q", path, got, response.Code, want)
		}
	}

	response := httptest.NewRecorder()
	api.browserProxyRequest(response, httptest.NewRequest(http.MethodGet, prefix+"/away", nil))
	if response.Code != http.StatusBadGateway || response.Header().Get("Location") != "" {
		t.Errorf("redirect to another origin was not refused: status=%d location=%q", response.Code, response.Header().Get("Location"))
	}
	// The error page fills the pane, so it must still let Tessera's window
	// shortcuts out.
	if !strings.Contains(response.Body.String(), browserProxyKeyRelayScript) {
		t.Errorf("proxy error page does not relay window shortcuts: %q", response.Body.String())
	}
}

func TestBrowserProxyInjectsBootstrapAfterHeadOrDoctype(t *testing.T) {
	target, _ := url.Parse("http://localhost:5000")
	for name, tc := range map[string]struct{ page, before string }{
		"plain head":      {`<!doctype html><html><head><title>x</title></head></html>`, `<!doctype html><html><head>`},
		"head attributes": {`<!DOCTYPE html><html lang="en"><head lang="en"><title>x</title></head></html>`, `<!DOCTYPE html><html lang="en"><head lang="en">`},
		"no head":         {"\ufeff<!-- built -->\n<!doctype html>\n<html lang=\"en\"><title>x</title><header>h</header>", "\ufeff<!-- built -->\n<!doctype html>\n<html lang=\"en\">"},
		"no doctype":      {`<p>fragment</p>`, ``},
	} {
		body := string(rewriteBrowserHTML([]byte(tc.page), "/browser-proxy/id", target))
		at := strings.Index(body, "<script>")
		if at < 0 || body[:at] != tc.before {
			t.Errorf("%s: bootstrap follows %q, want %q", name, body[:max(at, 0)], tc.before)
		}
		if strings.Count(body, "<script>") != 1 {
			t.Errorf("%s: bootstrap injected %d times", name, strings.Count(body, "<script>"))
		}
	}
}

func TestBrowserProxyEscapePageReplacesBlankFrame(t *testing.T) {
	handler := NewSecurityHandler(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("app"))
	}), nil, SecurityOptions{ConnectionLog: io.Discard})

	escaped := func(path, site string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1"+path, nil)
		request.Header.Set("Sec-Fetch-Dest", "iframe")
		request.Header.Set("Sec-Fetch-Site", site)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	response := escaped("/games/<x>", "cross-site")
	body := response.Body.String()
	if response.Code != http.StatusForbidden || !strings.Contains(body, "outside the browser proxy") || !strings.Contains(body, "/games/&lt;x&gt;") {
		t.Fatalf("escape page = %d %q", response.Code, body)
	}
	if response.Header().Get("X-Frame-Options") != "" {
		t.Errorf("escape page kept X-Frame-Options: %q", response.Header().Get("X-Frame-Options"))
	}
	if !strings.Contains(body, browserProxyKeyRelayScript) {
		t.Errorf("escape page does not relay window shortcuts")
	}
	policy := response.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "frame-ancestors 'self'") || !strings.HasPrefix(policy, "sandbox allow-scripts;") {
		t.Errorf("escape page policy = %q", policy)
	}

	for name, response := range map[string]*httptest.ResponseRecorder{
		"same-origin frame": escaped("/api/terminal-files/frame", "same-origin"),
		"proxy path":        escaped(browserProxyPrefix+"id/", "cross-site"),
	} {
		if response.Body.String() != "app" {
			t.Errorf("%s was answered with the escape page", name)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Body.String() != "app" || response.Header().Get("X-Frame-Options") != "DENY" {
		t.Errorf("unframed request changed: %q %v", response.Body.String(), response.Header())
	}
}

func TestBrowserProxyControlCreatesAndDeletesCapabilitySession(t *testing.T) {
	targetServer := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer targetServer.Close()
	api := &API{}

	request := httptest.NewRequest(http.MethodPost, "/api/browser-proxy", strings.NewReader(`{"target":`+jsonString(targetServer.URL+"/app")+`}`))
	response := httptest.NewRecorder()
	api.browserProxyControl(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d: %s", response.Code, response.Body.String())
	}
	var created struct {
		ID   string `json:"id"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if len(created.ID) != 48 || created.Path != browserProxyPrefix+created.ID+"/app" {
		t.Fatalf("unexpected proxy session: %+v", created)
	}

	request = httptest.NewRequest(http.MethodDelete, "/api/browser-proxy/"+created.ID, nil)
	response = httptest.NewRecorder()
	api.browserProxyControl(response, request)
	if response.Code != http.StatusNoContent || api.proxyManager().get(created.ID) != nil {
		t.Fatalf("proxy session was not deleted: status=%d", response.Code)
	}
}

func TestBrowserProxyForwardsWebSockets(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	targetServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		connection, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		messageType, message, err := connection.ReadMessage()
		if err == nil {
			_ = connection.WriteMessage(messageType, append([]byte("proxied:"), message...))
		}
	}))
	defer targetServer.Close()
	target, _ := url.Parse(targetServer.URL)
	session, err := newBrowserProxySession(target)
	if err != nil {
		t.Fatalf("new proxy session: %v", err)
	}
	api := &API{}
	api.proxyManager().add(session)
	proxyServer := httptest.NewServer(http.HandlerFunc(api.browserProxyRequest))
	defer proxyServer.Close()

	proxyURL := "ws" + strings.TrimPrefix(proxyServer.URL, "http") + browserProxyPrefix + session.id + "/socket"
	connection, _, err := websocket.DefaultDialer.Dial(proxyURL, nil)
	if err != nil {
		t.Fatalf("dial proxied WebSocket: %v", err)
	}
	defer connection.Close()
	if err := connection.WriteMessage(websocket.TextMessage, []byte("hello")); err != nil {
		t.Fatalf("write proxied WebSocket: %v", err)
	}
	_, message, err := connection.ReadMessage()
	if err != nil {
		t.Fatalf("read proxied WebSocket: %v", err)
	}
	if got := string(message); got != "proxied:hello" {
		t.Fatalf("proxied message = %q", got)
	}
}

func jsonString(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
