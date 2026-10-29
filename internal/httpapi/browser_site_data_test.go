package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/store"
)

func TestBrowserCookieJarFollowsRFC6265(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	jar := newBrowserCookieJar("localhost", nil, nil)
	jar.setFromResponse("/app/login", "sid=1; HttpOnly", now)    // default path /app
	jar.setFromResponse("/", "ui=dark; Path=/; Max-Age=60", now) // persistent
	jar.setFromResponse("/", "deep=1; Path=/app/settings", now)  // longer path
	jar.setFromResponse("/", "other=1; Domain=example.com", now) // foreign domain: refused
	jar.setFromResponse("/", "gone=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT", now)
	if got := jar.requestHeader("/app/settings/page", now); got != "deep=1; sid=1; ui=dark" {
		t.Fatalf("request header = %q", got)
	}
	if got := jar.requestHeader("/application", now); got != "ui=dark" {
		t.Fatalf("/application matched /app: %q", got)
	}
	if got := jar.scriptCookies("/app/x", now); got != "ui=dark" {
		t.Fatalf("script sees %q", got)
	}
	if jar.setFromScript("/app/x", "sid=forged; Path=/app", now) || jar.requestHeader("/app/x", now) != "sid=1; ui=dark" {
		t.Fatalf("script replaced an HttpOnly cookie: %q", jar.requestHeader("/app/x", now))
	}
	if jar.setFromScript("/", "evil=1; HttpOnly", now) {
		t.Fatal("script set an HttpOnly cookie")
	}
	if !jar.setFromScript("/", "ui=light; Path=/; Max-Age=60", now) || jar.scriptCookies("/", now) != "ui=light" {
		t.Fatalf("script write: %q", jar.scriptCookies("/", now))
	}
	jar.setFromScript("/", "ui=; Path=/; Max-Age=0", now)
	if got := jar.scriptCookies("/", now); got != "" {
		t.Fatalf("Max-Age=0 kept %q", got)
	}
	if got := jar.requestHeader("/", now.Add(2*time.Minute)); got != "" {
		t.Fatalf("root request header = %q", got)
	}
}

func TestBrowserCookieJarSavesOnlyPersistentCookies(t *testing.T) {
	var saved []store.BrowserCookie
	saves := 0
	jar := newBrowserCookieJar("localhost", nil, func(cookies []store.BrowserCookie) { saved, saves = cookies, saves+1 })
	now := time.Now()
	jar.setFromResponse("/", "session=1", now)
	if saves != 0 {
		t.Fatalf("a session cookie was saved")
	}
	jar.setFromResponse("/", "kept=1; Max-Age=60", now)
	if saves != 1 || len(saved) != 1 || saved[0].Name != "kept" {
		t.Fatalf("saved = %+v after %d saves", saved, saves)
	}
}

// browserSiteFixture is a development server that sets cookies and echoes
// what it receives, and a Tessera API with a store in front of it.
func browserSiteFixture(t *testing.T) (*API, *httptest.Server, *string) {
	t.Helper()
	received := new(string)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*received = r.Header.Get("Cookie")
		if r.URL.Path == "/login" {
			w.Header().Add("Set-Cookie", "sid=abc; HttpOnly; Path=/")
			w.Header().Add("Set-Cookie", "ui=dark; Path=/; Max-Age=3600")
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("ok"))
	}))
	t.Cleanup(target.Close)
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return &API{Store: st}, target, received
}

func openBrowserProxy(t *testing.T, api *API, target, pane, account string) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/browser-proxy", strings.NewReader(`{"target":"`+target+`","pane":"`+pane+`"}`))
	if account != "" {
		request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: account}))
	}
	response := httptest.NewRecorder()
	api.browserProxyControl(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create proxy: %d %s", response.Code, response.Body.String())
	}
	var created struct{ ID string }
	_ = json.Unmarshal(response.Body.Bytes(), &created)
	return created.ID
}

func browserState(t *testing.T, api *API, id, method, query, body string) (int, map[string]any) {
	t.Helper()
	request := httptest.NewRequest(method, browserProxyStatePrefix+id+query, strings.NewReader(body))
	response := httptest.NewRecorder()
	api.browserProxyState(response, request)
	if response.Header().Get("Access-Control-Allow-Origin") != "null" {
		t.Fatalf("state response isn't readable by the sandboxed page: %v", response.Header())
	}
	var data map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &data)
	return response.Code, data
}

func TestBrowserProxyKeepsCookiesInItsJar(t *testing.T) {
	api, target, received := browserSiteFixture(t)
	id := openBrowserProxy(t, api, target.URL, "pane-1", "")
	get := func(path string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, browserProxyPrefix+id+path, nil)
		request.Header.Set("Cookie", "tessera_signin=secret")
		response := httptest.NewRecorder()
		api.browserProxyRequest(response, request)
		return response
	}
	login := get("/login")
	if login.Header().Get("Set-Cookie") != "" {
		t.Fatalf("Set-Cookie reached the browser: %v", login.Header())
	}
	if login.Header().Get("X-Tessera-Cookies") != "stale" || !strings.Contains(login.Header().Get("Access-Control-Expose-Headers"), "X-Tessera-Cookies") {
		t.Fatalf("cookie change not signalled: %v", login.Header())
	}
	get("/next")
	if *received != "sid=abc; ui=dark" {
		t.Fatalf("development server got Cookie %q", *received)
	}
	if code, data := browserState(t, api, id, http.MethodGet, "?part=cookies&path=/", ""); code != http.StatusOK || data["cookies"] != "ui=dark" {
		t.Fatalf("script cookies = %d %v", code, data)
	}

	// The persistent cookie survives a restart; the session cookie doesn't.
	restarted := &API{Store: api.Store}
	again := openBrowserProxy(t, restarted, target.URL, "pane-1", "")
	request := httptest.NewRequest(http.MethodGet, browserProxyPrefix+again+"/", nil)
	restarted.browserProxyRequest(httptest.NewRecorder(), request)
	if *received != "ui=dark" {
		t.Fatalf("after restart the server got %q", *received)
	}
}

func TestBrowserProxyStateStoresAndIsolatesSiteData(t *testing.T) {
	api, target, _ := browserSiteFixture(t)
	id := openBrowserProxy(t, api, target.URL, "pane-1", "alice")
	code, data := browserState(t, api, id, http.MethodPost, "", `{"path":"/","ops":[
		{"s":"local","op":"set","k":"score","v":"10"},
		{"s":"session","op":"set","k":"tab","v":"2"},
		{"s":"cookie","v":"theme=green; Path=/"}]}`)
	if code != http.StatusOK || data["cookies"] != "theme=green" {
		t.Fatalf("apply = %d %v", code, data)
	}
	snapshot := func(id string) map[string]any {
		_, data := browserState(t, api, id, http.MethodGet, "?path=/", "")
		return data
	}
	if got := snapshot(id); got["local"].(map[string]any)["score"] != "10" || got["session"].(map[string]any)["tab"] != "2" || got["cookies"] != "theme=green" {
		t.Fatalf("snapshot = %v", got)
	}
	// The same pane after navigating keeps all of it; another pane keeps only
	// localStorage and cookies; another account sees none.
	if got := snapshot(openBrowserProxy(t, api, target.URL, "pane-1", "alice")); got["session"].(map[string]any)["tab"] != "2" {
		t.Fatalf("same pane lost sessionStorage: %v", got)
	}
	if got := snapshot(openBrowserProxy(t, api, target.URL, "pane-2", "alice")); len(got["session"].(map[string]any)) != 0 || got["local"].(map[string]any)["score"] != "10" {
		t.Fatalf("other pane = %v", got)
	}
	if got := snapshot(openBrowserProxy(t, api, target.URL, "pane-1", "bob")); len(got["local"].(map[string]any)) != 0 || got["cookies"] != "" {
		t.Fatalf("other account = %v", got)
	}

	big := strings.Repeat("x", browserStorageQuota)
	if code, data := browserState(t, api, id, http.MethodPost, "", `{"path":"/","ops":[{"s":"local","op":"set","k":"big","v":"`+big+`"}]}`); code != http.StatusRequestEntityTooLarge {
		t.Fatalf("over quota = %d %v", code, data)
	}
	if code, _ := browserState(t, api, "unknown", http.MethodGet, "?path=/", ""); code != http.StatusNotFound {
		t.Fatalf("unknown session = %d", code)
	}

	// Clear site data, as the pane's button does, and only by its account.
	clear := func(account string) int {
		request := httptest.NewRequest(http.MethodDelete, "/api/browser-proxy/"+id+"/site-data", nil)
		request = request.WithContext(context.WithValue(request.Context(), signInKey{}, store.SignIn{Account: account}))
		response := httptest.NewRecorder()
		api.browserProxyControl(response, request)
		return response.Code
	}
	if code := clear("bob"); code != http.StatusNotFound {
		t.Fatalf("another account cleared site data: %d", code)
	}
	if code := clear("alice"); code != http.StatusNoContent {
		t.Fatalf("clear = %d", code)
	}
	if got := snapshot(id); len(got["local"].(map[string]any)) != 0 || len(got["session"].(map[string]any)) != 0 || got["cookies"] != "" {
		t.Fatalf("after clear = %v", got)
	}
}

func TestBrowserProxyBootstrapInstallsSiteDataStandIns(t *testing.T) {
	body := string(rewriteBrowserHTML([]byte(`<head></head>`), browserProxyPrefix+"abc", &url.URL{Scheme: "http", Host: "localhost:5000"}))
	for _, fragment := range []string{`"/browser-proxy-state/abc","/browser-proxy/abc");`, `Object.defineProperty(window, name`, "tessera-browser-location"} {
		if !strings.Contains(body, fragment) {
			t.Errorf("bootstrap lacks %q", fragment)
		}
	}
	if strings.Contains(strings.ToLower(browserSiteDataScript), "</script") {
		t.Error("the stand-in script would end the injected <script> early")
	}
}
