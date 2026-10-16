package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tessera/internal/auth"
	"tessera/internal/store"
)

type authFixture struct {
	t       *testing.T
	handler http.Handler
	path    string
}

func newAuthFixture(t *testing.T, mutate func(*AuthOptions)) *authFixture {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	path := filepath.Join(t.TempDir(), "credentials")
	writeAccounts(t, path, map[string]string{"alice": "alice-password", "bob": "bob-password"})
	options := AuthOptions{Mode: AuthFile, Credentials: auth.NewCredentials(path)}
	if mutate != nil {
		mutate(&options)
	}
	api := &API{Store: st, AuthMode: options.Mode}
	mux := http.NewServeMux()
	api.Register(mux)
	handler := NewSecurityHandler(NewAuthHandler(mux, st, options), st, SecurityOptions{ConnectionLog: io.Discard, AllowedHosts: []string{"example.com"}})
	return &authFixture{t: t, handler: handler, path: path}
}

func writeAccounts(t *testing.T, path string, passwords map[string]string) {
	t.Helper()
	var accounts []auth.Account
	for _, name := range []string{"alice", "bob"} {
		if password, ok := passwords[name]; ok {
			hash, err := auth.HashPassword([]byte(password))
			if err != nil {
				t.Fatal(err)
			}
			accounts = append(accounts, auth.Account{Name: name, Hash: hash})
		}
	}
	if err := auth.WriteCredentialsFile(path, accounts); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Duration(len(passwords)) * time.Second)
	_ = os.Chtimes(path, later, later)
}

// editAccounts changes one account and keeps the others' hashes, as
// `tessera user passwd` and `remove` do.
func editAccounts(t *testing.T, path, name, password string) {
	t.Helper()
	accounts, err := auth.ReadCredentialsFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var kept []auth.Account
	for _, account := range accounts {
		if account.Name != name {
			kept = append(kept, account)
		} else if password != "" {
			hash, _ := auth.HashPassword([]byte(password))
			kept = append(kept, auth.Account{Name: name, Hash: hash})
		}
	}
	if err := auth.WriteCredentialsFile(path, kept); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Duration(len(kept)+5) * time.Second)
	_ = os.Chtimes(path, later, later)
}

func (f *authFixture) do(method, target, body, cookie, remote string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if cookie != "" {
		request.AddCookie(&http.Cookie{Name: signInCookie, Value: cookie})
	}
	request.RemoteAddr = "127.0.0.1:5000"
	if remote != "" {
		request.RemoteAddr = remote
	}
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	return recorder
}

func (f *authFixture) signIn(name, password string, remember bool) (string, *http.Cookie) {
	form := url.Values{"username": {name}, "password": {password}, "next": {"/u/alice"}}
	if remember {
		form.Set("remember", "1")
	}
	response := f.do(http.MethodPost, "/login", form.Encode(), "", "")
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == signInCookie {
			return cookie.Value, cookie
		}
	}
	return "", nil
}

func TestAuthOffLeavesHandlerUnchanged(t *testing.T) {
	next := http.NotFoundHandler()
	if handler := NewAuthHandler(next, nil, AuthOptions{}); handler == nil {
		t.Fatal("nil handler")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	recorder := httptest.NewRecorder()
	NewAuthHandler(next, nil, AuthOptions{Mode: AuthOff}).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestSignedOutRequests(t *testing.T) {
	f := newAuthFixture(t, nil)
	if code := f.do(http.MethodGet, "/api/users", "", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("api status = %d", code)
	}
	if code := f.do(http.MethodGet, "/api/terminal?paneId=p", "", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("websocket status = %d", code)
	}
	page := f.do(http.MethodGet, "/u/alice/s1?x=1", "", "", "")
	if page.Code != http.StatusSeeOther || page.Header().Get("Location") != "/login?next=%2Fu%2Falice%2Fs1%3Fx%3D1" {
		t.Fatalf("page = %d %q", page.Code, page.Header().Get("Location"))
	}
	if code := f.do(http.MethodGet, "/api/health", "", "", "").Code; code != http.StatusOK {
		t.Fatalf("health status = %d", code)
	}
	login := f.do(http.MethodGet, "/login", "", "", "")
	body := login.Body.String()
	if login.Code != http.StatusOK || !strings.Contains(body, `autocomplete="current-password"`) || !strings.Contains(body, `autocomplete="username"`) {
		t.Fatalf("login page = %d", login.Code)
	}
	if login.Header().Get("Cache-Control") != "no-store" || login.Header().Get("Referrer-Policy") != "same-origin" {
		t.Fatal("login page must not be cached and must keep its origin on form posts")
	}
}

func TestSignInScopesRequestsToTheAccount(t *testing.T) {
	f := newAuthFixture(t, nil)
	if value, _ := f.signIn("alice", "wrong", false); value != "" {
		t.Fatal("wrong password signed in")
	}
	if value, _ := f.signIn("nobody", "alice-password", false); value != "" {
		t.Fatal("unknown account signed in")
	}
	value, cookie := f.signIn("alice", "alice-password", false)
	if value == "" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode || cookie.MaxAge != 0 || cookie.Secure {
		t.Fatalf("cookie = %#v", cookie)
	}
	users := f.do(http.MethodGet, "/api/users", "", value, "")
	if users.Code != http.StatusOK || !strings.Contains(users.Body.String(), `"signedIn":"alice"`) || !strings.Contains(users.Body.String(), `"users":["alice"]`) {
		t.Fatalf("users = %d %s", users.Code, users.Body.String())
	}
	if code := f.do(http.MethodGet, "/api/users/alice/settings", "", value, "").Code; code != http.StatusOK {
		t.Fatalf("own settings = %d", code)
	}
	for _, other := range []string{"/api/users/bob/settings", "/api/users/default/settings"} {
		if code := f.do(http.MethodGet, other, "", value, "").Code; code != http.StatusNotFound {
			t.Fatalf("%s = %d", other, code)
		}
	}
	if code := f.do(http.MethodGet, "/login", "", value, "").Code; code != http.StatusSeeOther {
		t.Fatalf("signed-in login page = %d", code)
	}
}

func TestRememberedSignInIsPersistent(t *testing.T) {
	f := newAuthFixture(t, nil)
	_, cookie := f.signIn("alice", "alice-password", true)
	if cookie == nil || cookie.MaxAge < int(DefaultRememberIdle/time.Second)-5 {
		t.Fatalf("cookie = %#v", cookie)
	}
}

func TestSignInsEndOnPasswordChangeRemovalAndSignOut(t *testing.T) {
	f := newAuthFixture(t, nil)
	alice, _ := f.signIn("alice", "alice-password", false)
	bob, _ := f.signIn("bob", "bob-password", false)
	editAccounts(t, f.path, "alice", "new-password")
	if code := f.do(http.MethodGet, "/api/users", "", alice, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("after password change = %d", code)
	}
	if code := f.do(http.MethodGet, "/api/users", "", bob, "").Code; code != http.StatusOK {
		t.Fatalf("other account = %d", code)
	}
	logout := f.do(http.MethodPost, "/logout", "", bob, "")
	if logout.Code != http.StatusNoContent || !strings.Contains(logout.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("logout = %d", logout.Code)
	}
	if code := f.do(http.MethodGet, "/api/users", "", bob, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("after sign-out = %d", code)
	}
	carol, _ := f.signIn("alice", "new-password", false)
	editAccounts(t, f.path, "alice", "")
	if code := f.do(http.MethodGet, "/api/users", "", carol, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("after removal = %d", code)
	}
}

func TestPasswordsOverPlainHTTPFromAnotherDevice(t *testing.T) {
	form := url.Values{"username": {"alice"}, "password": {"alice-password"}}.Encode()
	f := newAuthFixture(t, nil)
	if !strings.Contains(f.do(http.MethodGet, "/login", "", "", "192.0.2.4:5000").Body.String(), "needs HTTPS") {
		t.Fatal("remote HTTP login page offers a password field")
	}
	if code := f.do(http.MethodPost, "/login", form, "", "192.0.2.4:5000").Code; code != http.StatusForbidden {
		t.Fatalf("remote HTTP POST = %d", code)
	}
	allowed := newAuthFixture(t, func(o *AuthOptions) { o.AllowHTTPSignIn = true })
	if code := allowed.do(http.MethodPost, "/login", form, "", "192.0.2.4:5000").Code; code != http.StatusSeeOther {
		t.Fatalf("allowed remote HTTP POST = %d", code)
	}
}

func TestSignInThrottling(t *testing.T) {
	f := newAuthFixture(t, nil)
	form := url.Values{"username": {"alice"}, "password": {"wrong"}}.Encode()
	for i := 0; i < 4; i++ {
		if code := f.do(http.MethodPost, "/login", form, "", "").Code; code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d", i, code)
		}
	}
	throttled := f.do(http.MethodPost, "/login", url.Values{"username": {"alice"}, "password": {"alice-password"}}.Encode(), "", "")
	if throttled.Code != http.StatusTooManyRequests || throttled.Header().Get("Retry-After") != "2" {
		t.Fatalf("throttled = %d %q", throttled.Code, throttled.Header().Get("Retry-After"))
	}
}

func TestLoginRejectsCrossOriginPosts(t *testing.T) {
	f := newAuthFixture(t, nil)
	request := httptest.NewRequest(http.MethodPost, "/login", strings.NewReader("username=alice&password=alice-password"))
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Origin", "http://evil.example")
	request.RemoteAddr = "127.0.0.1:5000"
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestSafeNext(t *testing.T) {
	for input, want := range map[string]string{
		"": "/", "/u/a?b=1": "/u/a?b=1", "//evil.example": "/", "/\\evil": "/", "https://evil.example/": "/",
		"relative": "/", "/login?next=/x": "/", "/x\r\nSet-Cookie: a": "/",
	} {
		if got := safeNext(input); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", input, got, want)
		}
	}
}
