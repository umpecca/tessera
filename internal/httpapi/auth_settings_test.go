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

	"tessera/internal/auth"
	"tessera/internal/store"
)

type settingsFixture struct {
	*authFixture
	// ended counts connections closed by the gate; see watchPath.
	ended chan struct{}
}

// watchPath is a stand-in for a websocket: it registers the request as an
// open connection and returns.
const watchPath = "/test/watch"

func newSettingsFixture(t *testing.T, mode string, mutate func(*AuthOptions)) *settingsFixture {
	t.Helper()
	st, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if mode == AuthFile {
		writeAccounts(t, st, map[string]string{"alice": "alice-password", "bob": "bob-password"})
		setAdmin(t, st, "alice", true)
	}
	options := AuthOptions{Mode: mode}
	if mutate != nil {
		mutate(&options)
	}
	ended := make(chan struct{}, 16)
	api := &API{Store: st}
	mux := http.NewServeMux()
	api.Register(mux)
	mux.HandleFunc(watchPath, func(w http.ResponseWriter, r *http.Request) {
		WatchSignIn(r.Context(), func() { ended <- struct{}{} })
		w.WriteHeader(http.StatusNoContent)
	})
	handler := NewSecurityHandler(NewAuthHandler(mux, st, options), st, SecurityOptions{ConnectionLog: io.Discard, AllowedHosts: []string{"example.com"}})
	return &settingsFixture{authFixture: &authFixture{t: t, handler: handler, store: st}, ended: ended}
}

func setAdmin(t *testing.T, st *store.Store, name string, admin bool) {
	t.Helper()
	err := st.UpdateAccounts(context.Background(), func(accounts []auth.Account) ([]auth.Account, error) {
		for i := range accounts {
			if accounts[i].Name == name {
				accounts[i].Admin = admin
			}
		}
		return accounts, nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func (f *settingsFixture) expectEnded(count int) {
	f.t.Helper()
	for i := 0; i < count; i++ {
		select {
		case <-f.ended:
		case <-time.After(2 * time.Second):
			f.t.Fatalf("connection %d of %d was not closed", i+1, count)
		}
	}
	select {
	case <-f.ended:
		f.t.Fatal("closed more connections than expected")
	case <-time.After(50 * time.Millisecond):
	}
}

func decodeBody(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q: %v", response.Body.String(), err)
	}
	return body
}

func TestTurningSignInOnFromSettings(t *testing.T) {
	f := newSettingsFixture(t, AuthOff, nil)
	ctx := context.Background()
	workspace, err := f.store.EnsureUserDefaultSession(ctx, store.DefaultWorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	settings := decodeBody(t, f.json(http.MethodGet, "/api/auth/settings", "", ""))
	if settings["mode"] != AuthOff || settings["canManage"] != true || settings["fileAvailable"] != true {
		t.Fatalf("settings = %v", settings)
	}
	f.json(http.MethodGet, watchPath, "", "")

	// Other devices can't send a password over plain HTTP.
	remote := httptest.NewRequest(http.MethodPut, "/api/auth/settings", strings.NewReader(`{"mode":"file","account":"carol","password":"pw"}`))
	remote.RemoteAddr = "192.0.2.4:5000"
	recorder := httptest.NewRecorder()
	f.handler.ServeHTTP(recorder, remote)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("remote HTTP = %d", recorder.Code)
	}
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"file","account":"a b","password":"pw"}`, "").Code; code != http.StatusBadRequest {
		t.Fatalf("bad name = %d", code)
	}

	on := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"file","account":"carol","password":"carol-password","moveWorkspaces":true}`, "")
	if on.Code != http.StatusOK || decodeBody(t, on)["moved"] != true {
		t.Fatalf("turn on = %d %s", on.Code, on.Body.String())
	}
	carol := signInCookieFrom(t, on)
	f.expectEnded(1)
	if account, ok, _ := f.store.Account(ctx, "carol"); !ok || !account.Admin {
		t.Fatalf("carol = %#v, %v", account, ok)
	}
	if mode, _ := f.store.LoadSignInMode(ctx); mode != AuthFile {
		t.Fatalf("saved mode = %q", mode)
	}
	if owner, _ := f.store.SessionOwner(ctx, workspace.ID); owner != "carol" {
		t.Fatalf("workspace owner = %q", owner)
	}
	if code := f.json(http.MethodGet, "/api/users", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("signed out after turning on = %d", code)
	}
	users := f.json(http.MethodGet, "/api/users", "", carol)
	if users.Code != http.StatusOK || !strings.Contains(users.Body.String(), `"auth":"file"`) || !strings.Contains(users.Body.String(), `"signedIn":"carol"`) {
		t.Fatalf("users = %d %s", users.Code, users.Body.String())
	}
}

func TestTurningSignInOffNeedsAdminAndPassword(t *testing.T) {
	f := newSettingsFixture(t, AuthFile, nil)
	alice, _ := f.signIn("alice", "alice-password", false)
	bob, _ := f.signIn("bob", "bob-password", false)
	if body := decodeBody(t, f.json(http.MethodGet, "/api/auth/settings", "", bob)); body["canManage"] != false {
		t.Fatalf("bob settings = %v", body)
	}
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"off","currentPassword":"bob-password"}`, bob).Code; code != http.StatusForbidden {
		t.Fatalf("non-admin = %d", code)
	}
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"off","currentPassword":"wrong"}`, alice).Code; code != http.StatusUnauthorized {
		t.Fatalf("wrong password = %d", code)
	}
	f.json(http.MethodGet, watchPath, "", alice)
	off := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"off","currentPassword":"alice-password"}`, alice)
	if off.Code != http.StatusOK || !strings.Contains(off.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("turn off = %d %s", off.Code, off.Body.String())
	}
	// This device's connections stay open while sign-in is off.
	f.expectEnded(0)
	users := f.json(http.MethodGet, "/api/users", "", "")
	if users.Code != http.StatusOK || !strings.Contains(users.Body.String(), `"auth":"off"`) {
		t.Fatalf("users = %d %s", users.Code, users.Body.String())
	}
	// Earlier sign-ins don't come back if sign-in is turned on again.
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"file","account":"alice","password":"alice-password"}`, "").Code; code != http.StatusOK {
		t.Fatalf("turn on again = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", bob).Code; code != http.StatusUnauthorized {
		t.Fatalf("old sign-in after turning on again = %d", code)
	}
}

func TestSignInSetWithFlagIsLocked(t *testing.T) {
	f := newSettingsFixture(t, AuthFile, func(o *AuthOptions) { o.ModeLocked = true })
	alice, _ := f.signIn("alice", "alice-password", false)
	if body := decodeBody(t, f.json(http.MethodGet, "/api/auth/settings", "", alice)); body["locked"] != true {
		t.Fatalf("settings = %v", body)
	}
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"off","currentPassword":"alice-password"}`, alice).Code; code != http.StatusConflict {
		t.Fatalf("locked change = %d", code)
	}
}

func TestSwitchingToHostAccount(t *testing.T) {
	f := newSettingsFixture(t, AuthOff, func(o *AuthOptions) {
		o.SystemAccount = "host"
		o.VerifySystem = func(_ context.Context, password []byte) error {
			if string(password) != "host-password" {
				return errWrongPassword
			}
			return nil
		}
	})
	if code := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"system","password":"nope"}`, "").Code; code != http.StatusUnauthorized {
		t.Fatalf("wrong host password = %d", code)
	}
	on := f.json(http.MethodPut, "/api/auth/settings", `{"mode":"system","password":"host-password"}`, "")
	if on.Code != http.StatusOK {
		t.Fatalf("system = %d %s", on.Code, on.Body.String())
	}
	host := signInCookieFrom(t, on)
	if body := decodeBody(t, f.json(http.MethodGet, "/api/auth/settings", "", host)); body["canManage"] != true || body["account"] != "host" {
		t.Fatalf("settings = %v", body)
	}
	// A file sign-in of the same name is not a host sign-in.
	if code := f.json(http.MethodGet, "/api/auth/accounts", "", host).Code; code != http.StatusConflict {
		t.Fatalf("accounts in system mode = %d", code)
	}
}

func TestManagingAccounts(t *testing.T) {
	f := newSettingsFixture(t, AuthFile, nil)
	alice, _ := f.signIn("alice", "alice-password", false)
	bob, _ := f.signIn("bob", "bob-password", false)
	if code := f.json(http.MethodGet, "/api/auth/accounts", "", bob).Code; code != http.StatusForbidden {
		t.Fatalf("non-admin list = %d", code)
	}
	list := f.json(http.MethodGet, "/api/auth/accounts", "", alice)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), `{"name":"alice","admin":true,"current":true}`) {
		t.Fatalf("list = %d %s", list.Code, list.Body.String())
	}

	if code := f.json(http.MethodPost, "/api/auth/accounts", `{"name":"carol","password":"carol-password"}`, alice).Code; code != http.StatusCreated {
		t.Fatalf("add = %d", code)
	}
	if code := f.json(http.MethodPost, "/api/auth/accounts", `{"name":"carol","password":"x"}`, alice).Code; code != http.StatusConflict {
		t.Fatalf("duplicate = %d", code)
	}
	if code := f.json(http.MethodPost, "/api/auth/accounts", `{"name":"dave","password":""}`, alice).Code; code != http.StatusBadRequest {
		t.Fatalf("no password = %d", code)
	}
	if value, _ := f.signIn("carol", "carol-password", false); value == "" {
		t.Fatal("new account can't sign in")
	}

	// The last admin stays an admin.
	if code := f.json(http.MethodPatch, "/api/auth/accounts/alice", `{"admin":false}`, alice).Code; code != http.StatusConflict {
		t.Fatalf("demote last admin = %d", code)
	}
	if code := f.json(http.MethodPatch, "/api/auth/accounts/bob", `{"admin":true}`, alice).Code; code != http.StatusOK {
		t.Fatalf("promote = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/auth/accounts", "", bob).Code; code != http.StatusOK {
		t.Fatalf("promoted list = %d", code)
	}

	// A new password ends that account's sign-ins and closes their
	// connections.
	f.json(http.MethodGet, watchPath, "", bob)
	if code := f.json(http.MethodPatch, "/api/auth/accounts/bob", `{"password":"bob-new"}`, alice).Code; code != http.StatusOK {
		t.Fatalf("set password = %d", code)
	}
	f.expectEnded(1)
	if code := f.json(http.MethodGet, "/api/users", "", bob).Code; code != http.StatusUnauthorized {
		t.Fatalf("bob after password change = %d", code)
	}

	// Changing your own password keeps this device signed in.
	f.json(http.MethodGet, watchPath, "", alice)
	own := f.json(http.MethodPatch, "/api/auth/accounts/alice", `{"password":"alice-new"}`, alice)
	if own.Code != http.StatusOK {
		t.Fatalf("own password = %d", own.Code)
	}
	renewed := signInCookieFrom(t, own)
	f.expectEnded(0)
	if code := f.json(http.MethodGet, "/api/users", "", alice).Code; code != http.StatusUnauthorized {
		t.Fatalf("old cookie = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", renewed).Code; code != http.StatusOK {
		t.Fatalf("renewed cookie = %d", code)
	}

	if code := f.json(http.MethodDelete, "/api/auth/accounts/alice", "", renewed).Code; code != http.StatusConflict {
		t.Fatalf("remove self = %d", code)
	}
	carol, _ := f.signIn("carol", "carol-password", false)
	if code := f.json(http.MethodDelete, "/api/auth/accounts/carol", "", renewed).Code; code != http.StatusNoContent {
		t.Fatalf("remove = %d", code)
	}
	if code := f.json(http.MethodGet, "/api/users", "", carol).Code; code != http.StatusUnauthorized {
		t.Fatalf("removed account = %d", code)
	}
	if code := f.json(http.MethodDelete, "/api/auth/accounts/carol", "", renewed).Code; code != http.StatusNotFound {
		t.Fatalf("remove again = %d", code)
	}
}

func TestListensBeyondHost(t *testing.T) {
	for address, want := range map[string]bool{
		"127.0.0.1:7331": false, "localhost:7331": false, "[::1]:7331": false,
		"0.0.0.0:7331": true, ":7331": true, "192.168.1.5:7331": true, "tessera.lan:7331": true,
	} {
		if got := listensBeyondHost(address); got != want {
			t.Errorf("listensBeyondHost(%q) = %v", address, got)
		}
	}
}

func TestAccountsModeWithoutAccountsWaitsForOne(t *testing.T) {
	f := newSettingsFixture(t, AuthFile, nil)
	if err := f.store.UpdateAccounts(context.Background(), func([]auth.Account) ([]auth.Account, error) { return nil, nil }); err != nil {
		t.Fatal(err)
	}
	login := f.do(http.MethodGet, "/login", "", "", "")
	if !strings.Contains(login.Body.String(), "Nobody can sign in") || strings.Contains(login.Body.String(), `name="password"`) {
		t.Fatalf("login page = %s", login.Body.String())
	}
	if code := f.json(http.MethodGet, "/api/users", "", "").Code; code != http.StatusUnauthorized {
		t.Fatalf("signed out = %d", code)
	}
	// `tessera user add` on the host applies without a restart.
	writeAccounts(t, f.store, map[string]string{"alice": "alice-password"})
	if value, _ := f.signIn("alice", "alice-password", false); value == "" {
		t.Fatal("added account can't sign in")
	}
}
