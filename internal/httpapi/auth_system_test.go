package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/auth"
	"tessera/internal/store"
)

func fakeSystemVerify(_ context.Context, password []byte) error {
	switch string(password) {
	case "host-password":
		return nil
	case "helper-missing":
		return ErrSystemAuthUnavailable
	}
	return errors.New("incorrect")
}

func newSystemFixture(t *testing.T, users []string) (*authFixture, *authGate) {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	tokenPath := filepath.Join(t.TempDir(), "auth-token")
	if _, err := auth.EnsureToken(tokenPath); err != nil {
		t.Fatal(err)
	}
	options := AuthOptions{Mode: AuthSystem, SystemAccount: "hostuser", VerifySystem: fakeSystemVerify, TokenPath: tokenPath}
	api := &API{Store: st, AuthMode: AuthSystem, Users: users}
	mux := http.NewServeMux()
	api.Register(mux)
	gate := NewAuthHandler(mux, st, options).(*authGate)
	handler := NewSecurityHandler(gate, st, SecurityOptions{ConnectionLog: io.Discard, AllowedHosts: []string{"example.com"}})
	return &authFixture{t: t, handler: handler}, gate
}

func TestSystemSignIn(t *testing.T) {
	f, _ := newSystemFixture(t, []string{"work", "play"})
	page := f.do(http.MethodGet, "/login", "", "", "").Body.String()
	if !strings.Contains(page, `name="username" autocomplete="username" value="hostuser"`) || strings.Contains(page, `type="text"`) {
		t.Fatal("system login page must fix the account and offer only a password field")
	}
	wrong := f.do(http.MethodPost, "/login", url.Values{"password": {"nope"}}.Encode(), "", "")
	if wrong.Code != http.StatusUnauthorized || !strings.Contains(wrong.Body.String(), "Incorrect password.") {
		t.Fatalf("wrong password = %d", wrong.Code)
	}
	unavailable := f.do(http.MethodPost, "/login", url.Values{"password": {"helper-missing"}}.Encode(), "", "")
	if unavailable.Code != http.StatusServiceUnavailable || !strings.Contains(unavailable.Body.String(), "tessera login") {
		t.Fatalf("unavailable = %d", unavailable.Code)
	}
	// A submitted name cannot pick another account.
	value, _ := f.signIn("someone-else", "host-password", false)
	if value == "" {
		t.Fatal("correct password did not sign in")
	}
	users := f.do(http.MethodGet, "/api/users", "", value, "").Body.String()
	if !strings.Contains(users, `"signedIn":"hostuser"`) || !strings.Contains(users, `"users":["work","play"]`) {
		t.Fatalf("users = %s", users)
	}
	if code := f.do(http.MethodGet, "/api/users/play/settings", "", value, "").Code; code != http.StatusOK {
		t.Fatalf("roster user after system sign-in = %d", code)
	}
}

func (f *authFixture) hostPost(path, token, body string, mutate func(*http.Request)) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.RemoteAddr = "127.0.0.1:6000"
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if mutate != nil {
		mutate(request)
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

func TestRecoveryLinks(t *testing.T) {
	f, gate := newSystemFixture(t, nil)
	token, _ := auth.ReadToken(gate.opts.TokenPath)
	for name, response := range map[string]*httptest.ResponseRecorder{
		"no token":    f.hostPost("/api/auth/recovery-link", "", "", nil),
		"wrong token": f.hostPost("/api/auth/recovery-link", strings.Repeat("0", 64), "", nil),
		"remote":      f.hostPost("/api/auth/recovery-link", token, "", func(r *http.Request) { r.RemoteAddr = "192.0.2.9:1" }),
		"proxied":     f.hostPost("/api/auth/recovery-link", token, "", func(r *http.Request) { r.Header.Set("X-Forwarded-For", "192.0.2.9") }),
		"browser":     f.hostPost("/api/auth/recovery-link", token, "", func(r *http.Request) { r.Header.Set("Origin", "http://127.0.0.1") }),
	} {
		if response.Code == http.StatusOK {
			t.Errorf("%s: issued a link", name)
		}
	}
	issued := f.hostPost("/api/auth/recovery-link", token, "", nil)
	var link struct{ Path, Account string }
	if err := json.Unmarshal(issued.Body.Bytes(), &link); err != nil || issued.Code != http.StatusOK || link.Account != "hostuser" {
		t.Fatalf("issue = %d %s", issued.Code, issued.Body.String())
	}
	redeemed := f.do(http.MethodGet, link.Path, "", "", "")
	cookie := ""
	for _, c := range redeemed.Result().Cookies() {
		if c.Name == signInCookie {
			cookie = c.Value
		}
	}
	if redeemed.Code != http.StatusSeeOther || cookie == "" {
		t.Fatalf("redeem = %d", redeemed.Code)
	}
	if code := f.do(http.MethodGet, "/api/users", "", cookie, "").Code; code != http.StatusOK {
		t.Fatalf("link sign-in = %d", code)
	}
	if code := f.do(http.MethodGet, link.Path, "", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("reused link = %d", code)
	}
	// Links expire after two minutes.
	stale := f.hostPost("/api/auth/recovery-link", token, "", nil)
	_ = json.Unmarshal(stale.Body.Bytes(), &link)
	now := gate.now
	gate.now = func() time.Time { return now().Add(recoveryLinkLifetime + time.Second) }
	if code := f.do(http.MethodGet, link.Path, "", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("expired link = %d", code)
	}
	gate.now = now

	ended := f.hostPost("/api/auth/revoke-all", token, "", nil)
	if ended.Code != http.StatusOK || !strings.Contains(ended.Body.String(), `"ended":1`) {
		t.Fatalf("revoke-all = %d %s", ended.Code, ended.Body.String())
	}
	if code := f.do(http.MethodGet, "/api/users", "", cookie, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("after revoke-all = %d", code)
	}
}

func TestFileModeRecoveryLinkNeedsAnAccount(t *testing.T) {
	tokenPath := filepath.Join(t.TempDir(), "auth-token")
	token, _ := auth.EnsureToken(tokenPath)
	f := newAuthFixture(t, func(o *AuthOptions) { o.TokenPath = tokenPath })
	if code := f.hostPost("/api/auth/recovery-link", token, `{"account":"ghost"}`, nil).Code; code != http.StatusBadRequest {
		t.Fatalf("unknown account = %d", code)
	}
	if code := f.hostPost("/api/auth/recovery-link", token, `{"account":"alice"}`, nil).Code; code != http.StatusOK {
		t.Fatalf("alice = %d", code)
	}
}
