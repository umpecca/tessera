package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"tessera/internal/auth"
)

func TestRuntimeAccountSupersedesSavedAccountsAndCookiesWithoutChangingThem(t *testing.T) {
	f := newSettingsFixture(t, AuthFile, nil)
	alice, _ := f.signIn("alice", "alice-password", true)
	bob, _ := f.signIn("bob", "bob-password", true)
	ctx := context.Background()
	before, _ := f.store.Accounts(ctx)
	// Intentionally reuse the exact saved name/hash: cookie isolation must
	// depend on the CLI namespace, not just the likelihood of different salts.
	account, _, _ := f.store.Account(ctx, "alice")
	normal := f.handler
	f.handler = NewAuthHandler(normal, f.store, AuthOptions{Mode: AuthOff, RuntimeAccount: &account})
	for _, cookie := range []string{alice, bob} {
		if got := f.do(http.MethodGet, "/api/users", "", cookie, "").Code; got != http.StatusUnauthorized {
			t.Fatalf("saved cookie bypassed override: %d", got)
		}
	}
	if value, _ := f.signIn("bob", "bob-password", false); value != "" {
		t.Fatal("saved account signed in")
	}
	cli, _ := f.signIn("alice", "alice-password", true)
	if cli == "" {
		t.Fatal("CLI credentials failed")
	}
	// Use an unwrapped handler to inspect Settings, without the normal inner
	// gate rejecting the intentionally different CLI credential namespace.
	gate := f.handler.(*authGate)
	gate.next = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	if code := f.do(http.MethodGet, "/api/users", "", cli, "").Code; code != http.StatusOK {
		t.Fatalf("CLI cookie = %d", code)
	}
	settings := decodeBody(t, f.json(http.MethodGet, "/api/auth/settings", "", cli))
	if settings["locked"] != true || settings["cliAccount"] != true || settings["canManage"] != true || settings["noAdmins"] != false {
		t.Fatalf("settings = %v", settings)
	}
	accounts := f.json(http.MethodGet, "/api/auth/accounts", "", cli)
	if strings.Contains(accounts.Body.String(), "bob") || !strings.Contains(accounts.Body.String(), `"admin":true`) {
		t.Fatal("exposed saved accounts instead of CLI admin")
	}
	for _, change := range []struct{ method, path, body string }{
		{http.MethodPut, "/api/auth/settings", `{"mode":"off"}`},
		{http.MethodPost, "/api/auth/accounts", `{"name":"carol","password":"secret"}`},
		{http.MethodPatch, "/api/auth/accounts/alice", `{"password":"changed"}`},
		{http.MethodDelete, "/api/auth/accounts/bob", ""},
	} {
		if code := f.json(change.method, change.path, change.body, cli).Code; code != http.StatusConflict {
			t.Fatalf("%s %s = %d", change.method, change.path, code)
		}
	}
	after, _ := f.store.Accounts(ctx)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("saved credentials changed")
	}
	f.handler = normal
	if code := f.do(http.MethodGet, "/api/users", "", cli, "").Code; code != http.StatusUnauthorized {
		t.Fatal("CLI cookie survived removing override")
	}
	for _, cookie := range []string{alice, bob} {
		if code := f.do(http.MethodGet, "/api/users", "", cookie, "").Code; code != http.StatusOK {
			t.Fatal("saved cookie not restored")
		}
	}
	if value, _ := f.signIn("bob", "bob-password", false); value == "" {
		t.Fatal("saved credentials not restored")
	}
}

func TestRuntimeAccountPasswordTransportThrottlingAndRecovery(t *testing.T) {
	hash, _ := auth.HashPassword([]byte("cli-password"))
	f := newSettingsFixture(t, AuthFile, func(o *AuthOptions) {
		o.RuntimeAccount = &auth.Account{Name: "cli", Hash: hash, Admin: true}
	})
	if code := f.do(http.MethodPost, "/login", "username=cli&password=cli-password", "", "192.0.2.1:5000").Code; code != http.StatusForbidden {
		t.Fatalf("insecure transport = %d", code)
	}
	if value, _ := f.signIn("alice", "alice-password", false); value != "" {
		t.Fatal("saved password accepted")
	}
	if value, _ := f.signIn("cli", "cli-password", false); value == "" {
		t.Fatal("CLI password rejected")
	}
	for range 12 {
		f.signIn("cli", "wrong-password", false)
	}
	if code := f.do(http.MethodPost, "/login", "username=cli&password=wrong-password", "", "").Code; code != http.StatusTooManyRequests {
		t.Fatalf("throttle = %d", code)
	}
	// Local recovery must not mint a sign-in for a dormant saved account.
	token, err := f.store.RecoveryToken(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	issue := func(name string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/recovery-link", strings.NewReader(`{"account":"`+name+`"}`))
		r.RemoteAddr = "127.0.0.1:5000"
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		return w
	}
	if code := issue("alice").Code; code != http.StatusBadRequest {
		t.Fatalf("saved recovery account = %d", code)
	}
	issued := issue("cli")
	if issued.Code != http.StatusOK {
		t.Fatalf("CLI recovery = %d", issued.Code)
	}
	path := decodeBody(t, issued)["path"].(string)
	redeemed := f.do(http.MethodGet, path, "", "", "")
	if redeemed.Code != http.StatusSeeOther {
		t.Fatalf("redeem = %d", redeemed.Code)
	}
	for _, cookie := range redeemed.Result().Cookies() {
		if cookie.Name == signInCookie && f.do(http.MethodGet, "/api/users", "", cookie.Value, "").Code == http.StatusOK {
			return
		}
	}
	t.Fatal("recovery cookie did not authenticate as CLI account")
}

func TestRuntimeAccountWorksWithoutSavedAccountsAndRejectsHostCookies(t *testing.T) {
	f := newSettingsFixture(t, AuthSystem, func(o *AuthOptions) {
		o.SystemAccount = "host"
		o.VerifySystem = func(context.Context, []byte) error { return nil }
	})
	old, _ := f.signIn("host", "host-password", true)
	if old == "" {
		t.Fatal("host fixture sign-in failed")
	}
	hash, _ := auth.HashPassword([]byte("cli-password"))
	f.handler = NewAuthHandler(http.NotFoundHandler(), f.store, AuthOptions{
		RuntimeAccount: &auth.Account{Name: "host", Hash: hash},
	})
	if code := f.do(http.MethodGet, "/api/users", "", old, "").Code; code != http.StatusUnauthorized {
		t.Fatal("host cookie bypassed CLI override")
	}
	page := f.do(http.MethodGet, "/login", "", "", "")
	if page.Code != http.StatusOK || strings.Contains(page.Body.String(), "Nobody can sign in") {
		t.Fatal("CLI login blocked by missing saved accounts")
	}
	cli, _ := f.signIn("host", "cli-password", true)
	if cli == "" {
		t.Fatal("CLI account required saved accounts")
	}
	if accounts, _ := f.store.Accounts(context.Background()); len(accounts) != 0 {
		t.Fatal("CLI account was persisted")
	}
	// A new process creates a fresh salted hash even for identical input.
	nextHash, _ := auth.HashPassword([]byte("cli-password"))
	f.handler = NewAuthHandler(http.NotFoundHandler(), f.store, AuthOptions{RuntimeAccount: &auth.Account{Name: "host", Hash: nextHash}})
	if code := f.do(http.MethodGet, "/api/users", "", cli, "").Code; code != http.StatusUnauthorized {
		t.Fatal("old CLI cookie survived a fresh credential hash")
	}
}
