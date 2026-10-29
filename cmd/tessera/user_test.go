package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tessera/internal/auth"
	"tessera/internal/store"
)

func runUser(t *testing.T, path, stdin string, hidden func() ([]byte, error), args ...string) (string, error) {
	t.Helper()
	var stdout, stderr bytes.Buffer
	full := append([]string{args[0], "-db", path, "-auth-file="}, args[1:]...)
	err := runUserCommand(full, strings.NewReader(stdin), &stdout, &stderr, hidden)
	return stdout.String(), err
}

func TestUserCommands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "Tessera", "tessera.sqlite3")
	if _, err := runUser(t, path, "first secret\n", nil, "add", "-password-stdin", "alice"); err != nil {
		t.Fatal(err)
	}
	if _, err := runUser(t, path, "x\n", nil, "add", "-password-stdin", "alice"); !errors.Is(err, auth.ErrAccountExists) {
		t.Fatalf("duplicate add: %v", err)
	}
	prompts := [][]byte{[]byte("second secret"), []byte("second secret")}
	hidden := func() ([]byte, error) { next := prompts[0]; prompts = prompts[1:]; return next, nil }
	if _, err := runUser(t, path, "", hidden, "add", "bob"); err != nil {
		t.Fatal(err)
	}
	accounts := readAccounts(t, path)
	if len(accounts) != 2 {
		t.Fatalf("accounts = %v", accounts)
	}
	if ok, _ := auth.VerifyPassword(accounts[0].Hash, []byte("first secret")); !ok {
		t.Fatal("stdin password was not stored")
	}
	if ok, _ := auth.VerifyPassword(accounts[1].Hash, []byte("second secret")); !ok {
		t.Fatal("prompted password was not stored")
	}
	if _, err := runUser(t, path, "changed\n", nil, "passwd", "-password-stdin", "alice"); err != nil {
		t.Fatal(err)
	}
	if account := mustLookup(t, path, "alice"); account.Hash == accounts[0].Hash {
		t.Fatal("passwd did not change the hash")
	}
	if mustLookup(t, path, "bob").Hash != accounts[1].Hash {
		t.Fatal("passwd changed another account")
	}
	// The first account is an admin; later ones only when asked.
	if out, err := runUser(t, path, "", nil, "list"); err != nil || out != "alice (admin)\nbob\n" {
		t.Fatalf("list = %q, %v", out, err)
	}
	if _, err := runUser(t, path, "", nil, "admin", "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := runUser(t, path, "", nil, "admin", "-revoke", "alice"); err != nil {
		t.Fatal(err)
	}
	if out, _ := runUser(t, path, "", nil, "list"); out != "alice\nbob (admin)\n" {
		t.Fatalf("after admin = %q", out)
	}
	if mustLookup(t, path, "bob").Hash != accounts[1].Hash {
		t.Fatal("admin changed the password")
	}
	if _, err := runUser(t, path, "pw\n", nil, "add", "-password-stdin", "-admin", "carol"); err != nil || !mustLookup(t, path, "carol").Admin {
		t.Fatalf("add -admin: %v", err)
	}
	if _, err := runUser(t, path, "", nil, "remove", "carol"); err != nil {
		t.Fatal(err)
	}
	if _, err := runUser(t, path, "", nil, "remove", "alice"); err != nil {
		t.Fatal(err)
	}
	if out, _ := runUser(t, path, "", nil, "list"); out != "bob (admin)\n" {
		t.Fatalf("after remove = %q", out)
	}
}

func TestUserCommandRejections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tessera.sqlite3")
	mismatch := [][]byte{[]byte("one"), []byte("two")}
	hidden := func() ([]byte, error) { next := mismatch[0]; mismatch = mismatch[1:]; return next, nil }
	cases := []struct {
		name   string
		hidden func() ([]byte, error)
		stdin  string
		args   []string
	}{
		{"mismatched prompts", hidden, "", []string{"add", "alice"}},
		{"no terminal", nil, "", []string{"add", "alice"}},
		{"empty stdin password", nil, "\n", []string{"add", "-password-stdin", "alice"}},
		{"bad name", nil, "x\n", []string{"add", "-password-stdin", "a:b"}},
		{"missing account", nil, "x\n", []string{"passwd", "-password-stdin", "ghost"}},
		{"admin of a missing account", nil, "", []string{"admin", "ghost"}},
		{"unknown command", nil, "", []string{"rename", "alice"}},
	}
	for _, c := range cases {
		if _, err := runUser(t, path, c.stdin, c.hidden, c.args...); err == nil {
			t.Errorf("%s: accepted", c.name)
		}
	}
}

func readAccounts(t *testing.T, path string) []auth.Account {
	t.Helper()
	st, err := store.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	accounts, err := st.Accounts(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return accounts
}

func mustLookup(t *testing.T, path, name string) auth.Account {
	t.Helper()
	for _, account := range readAccounts(t, path) {
		if account.Name == name {
			return account
		}
	}
	t.Fatalf("no account %s", name)
	return auth.Account{}
}

// The first `tessera user` after upgrading brings the accounts of the old
// credentials file along.
func TestUserCommandImportsCredentialsFile(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "credentials")
	if err := os.WriteFile(file, []byte("alice:$argon2id$a:admin\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := runUserCommand([]string{"list", "-db", filepath.Join(dir, "tessera.sqlite3"), "-auth-file", file}, strings.NewReader(""), &stdout, &stderr, nil)
	if err != nil || stdout.String() != "alice (admin)\n" {
		t.Fatalf("list = %q, %v", stdout.String(), err)
	}
}

func TestAuthOptionsFromFlags(t *testing.T) {
	if options, err := authOptionsFromFlags("off", []string{"a"}, false, 1, 1); err != nil || options.Mode != "off" {
		t.Fatalf("off: %v", err)
	}
	// Without -auth the mode comes from Settings, so nothing is checked yet.
	if options, err := authOptionsFromFlags("", []string{"a"}, false, 1, 1); err != nil || options.ModeLocked || !options.MultiUser {
		t.Fatalf("unset: %#v, %v", options, err)
	}
	if _, err := authOptionsFromFlags("file", []string{"bob"}, false, 1, 1); err == nil {
		t.Fatal("-users with -auth=file accepted")
	}
	if options, err := authOptionsFromFlags("file", nil, true, 1, 1); err != nil || !options.AllowHTTPSignIn {
		t.Fatalf("file: %#v, %v", options, err)
	}
	if _, err := authOptionsFromFlags("ldap", nil, false, 1, 1); err == nil {
		t.Fatal("unknown mode accepted")
	}
	// The host account is one identity; -users stays a workspace picker.
	system, err := authOptionsFromFlags("system", []string{"a", "b"}, false, 1, 1)
	if err != nil || system.SystemAccount == "" || system.VerifySystem == nil {
		t.Fatalf("system: %#v, %v", system, err)
	}
}
