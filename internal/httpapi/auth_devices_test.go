package httpapi

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

	"tessera/internal/store"
)

func (f *authFixture) json(method, target, body, cookie string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "127.0.0.1:5000"
	request.Header.Set("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15")
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: signInCookie, Value: cookie})
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

func signInCookieFrom(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == signInCookie && cookie.Value != "" {
			return cookie.Value
		}
	}
	t.Fatalf("no sign-in cookie (status %d: %s)", response.Code, response.Body.String())
	return ""
}

func TestJSONSignIn(t *testing.T) {
	f := newAuthFixture(t, nil)
	wrong := f.json(http.MethodPost, "/api/auth/login", `{"username":"alice","password":"nope"}`, "")
	if wrong.Code != http.StatusUnauthorized || !strings.Contains(wrong.Body.String(), "Incorrect name or password.") {
		t.Fatalf("wrong = %d %s", wrong.Code, wrong.Body.String())
	}
	for i := 0; i < 3; i++ {
		f.json(http.MethodPost, "/api/auth/login", `{"username":"alice","password":"nope"}`, "")
	}
	throttled := f.json(http.MethodPost, "/api/auth/login", `{"username":"alice","password":"alice-password"}`, "")
	if throttled.Code != http.StatusTooManyRequests || !strings.Contains(throttled.Body.String(), `"retryAfter":2`) {
		t.Fatalf("throttled = %d %s", throttled.Code, throttled.Body.String())
	}
	g := newAuthFixture(t, nil)
	ok := g.json(http.MethodPost, "/api/auth/login", `{"username":"alice","password":"alice-password","remember":true}`, "")
	if ok.Code != http.StatusOK || !strings.Contains(ok.Body.String(), `"account":"alice"`) {
		t.Fatalf("ok = %d %s", ok.Code, ok.Body.String())
	}
	if code := g.json(http.MethodGet, "/api/users", "", signInCookieFrom(t, ok)).Code; code != http.StatusOK {
		t.Fatalf("after JSON sign-in = %d", code)
	}
}

func TestSignedInDevices(t *testing.T) {
	f := newAuthFixture(t, nil)
	login := func(name, password string) string {
		return signInCookieFrom(t, f.json(http.MethodPost, "/api/auth/login", `{"username":"`+name+`","password":"`+password+`"}`, ""))
	}
	laptop, tablet, bob := login("alice", "alice-password"), login("alice", "alice-password"), login("bob", "bob-password")
	list := f.json(http.MethodGet, "/api/auth/sign-ins", "", laptop)
	var body struct {
		Account string
		SignIns []signInView
	}
	if err := json.Unmarshal(list.Body.Bytes(), &body); err != nil || list.Code != http.StatusOK {
		t.Fatalf("list = %d %s", list.Code, list.Body.String())
	}
	if body.Account != "alice" || len(body.SignIns) != 2 {
		t.Fatalf("alice sees %d sign-ins (bob's must not appear)", len(body.SignIns))
	}
	var tabletID string
	for _, signIn := range body.SignIns {
		if signIn.Device != "Safari on macOS" || signIn.LastIP != "127.0.0.1" {
			t.Fatalf("view = %#v", signIn)
		}
		if !signIn.Current {
			tabletID = signIn.ID
		}
	}
	// Bob cannot end Alice's sign-ins.
	if code := f.json(http.MethodDelete, "/api/auth/sign-ins/"+tabletID, "", bob).Code; code != http.StatusNotFound {
		t.Fatalf("bob revoking alice = %d", code)
	}
	if code := f.json(http.MethodDelete, "/api/auth/sign-ins/"+tabletID, "", laptop).Code; code != http.StatusNoContent {
		t.Fatalf("revoke tablet = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", tablet).Code; code != http.StatusUnauthorized {
		t.Fatalf("revoked tablet = %d", code)
	}
	everywhere := f.json(http.MethodDelete, "/api/auth/sign-ins", "", laptop)
	if everywhere.Code != http.StatusNoContent || !strings.Contains(everywhere.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("sign out everywhere = %d", everywhere.Code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", laptop).Code; code != http.StatusUnauthorized {
		t.Fatalf("after everywhere = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", bob).Code; code != http.StatusOK {
		t.Fatalf("bob after alice signed out everywhere = %d", code)
	}
}

func TestDescribeDevice(t *testing.T) {
	for agent, want := range map[string]string{
		"Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148":                  "App on iPadOS",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36":           "Chrome on Windows",
		"Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0":                                                "Firefox on Linux",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0 Safari/537.36 Edg/148.0": "Edge on Windows",
		"curl/8.7.1": "Browser", "": "Unknown device",
	} {
		if got := describeDevice(agent); got != want {
			t.Errorf("describeDevice(%q) = %q, want %q", agent, got, want)
		}
	}
}

func TestSignInAuditEvents(t *testing.T) {
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	writeAccounts(t, st, map[string]string{"alice": "alice-password"})
	mux := http.NewServeMux()
	(&API{Store: st, AuthMode: AuthFile}).Register(mux)
	gate := NewAuthHandler(mux, st, AuthOptions{Mode: AuthFile})
	f := &authFixture{t: t, store: st, handler: NewSecurityHandler(gate, st, SecurityOptions{ConnectionLog: io.Discard,
		AllowedHosts: []string{"example.com"}, AuditEnabled: true, AuditRetention: 24 * time.Hour})}

	f.signIn("alice", "wrong", false)
	cookie, _ := f.signIn("alice", "alice-password", false)
	f.do(http.MethodPost, "/logout", "", cookie, "")
	events, err := st.ListAuditEvents(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		withID := "no id"
		if event.SignInID != "" {
			withID = "id"
		}
		got = append(got, event.Method+" "+event.Path+" "+event.Outcome+" "+withID)
	}
	want := []string{"POST /login denied no id", "POST /login success id", "POST /logout success id"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("audit = %v", got)
	}
	for _, event := range events {
		if strings.Contains(event.Path, "password") {
			t.Fatal("audit leaked form content")
		}
	}
}
