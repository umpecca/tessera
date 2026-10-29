package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"tessera/internal/auth"
)

func TestAccountsUpdateKeepsOrderAndRows(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	add := func(accounts []auth.Account) ([]auth.Account, error) {
		return append(accounts, auth.Account{Name: "alice", Hash: "$argon2id$a", Admin: true}, auth.Account{Name: "bob", Hash: "$argon2id$b"}), nil
	}
	if err := st.UpdateAccounts(ctx, add); err != nil {
		t.Fatal(err)
	}
	// Changing alice keeps her ahead of bob; carol joins at the end.
	err = st.UpdateAccounts(ctx, func(accounts []auth.Account) ([]auth.Account, error) {
		accounts[0].Hash = "$argon2id$a2"
		return append(accounts, auth.Account{Name: "carol", Hash: "$argon2id$c"}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	accounts, err := st.Accounts(ctx)
	if err != nil || len(accounts) != 3 || accounts[0].Name != "alice" || accounts[0].Hash != "$argon2id$a2" || !accounts[0].Admin || accounts[2].Name != "carol" {
		t.Fatalf("accounts = %#v, %v", accounts, err)
	}
	if err := st.UpdateAccounts(ctx, func(accounts []auth.Account) ([]auth.Account, error) { return accounts[1:2], nil }); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := st.Account(ctx, "alice"); ok || err != nil {
		t.Fatalf("removed alice: %v, %v", ok, err)
	}
	if bob, ok, err := st.Account(ctx, "bob"); !ok || err != nil || bob.Hash != "$argon2id$b" {
		t.Fatalf("bob = %#v, %v, %v", bob, ok, err)
	}
	// A refused change, or one with a duplicate, saves nothing.
	refused := errors.New("refused")
	if err := st.UpdateAccounts(ctx, func([]auth.Account) ([]auth.Account, error) { return nil, refused }); !errors.Is(err, refused) {
		t.Fatalf("refused = %v", err)
	}
	if err := st.UpdateAccounts(ctx, add); !errors.Is(err, auth.ErrAccountExists) {
		t.Fatalf("duplicate = %v", err)
	}
	if accounts, _ := st.Accounts(ctx); len(accounts) != 1 {
		t.Fatalf("after refusals = %#v", accounts)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(path); info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("database mode = %v", info.Mode().Perm())
		}
	}
}
