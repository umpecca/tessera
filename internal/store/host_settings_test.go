package store

import (
	"context"
	"path/filepath"
	"reflect"
	"testing"

	"tessera/internal/localhttps"
)

func TestLocalHTTPSConfigPersistsAcrossStoreRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	config := localhttps.Config{
		Enabled: true, HTTPSAddress: "0.0.0.0:7443",
		DNSNames: []string{"tessera.local"}, IPAddresses: []string{"192.168.1.20"},
	}
	if err := st.SaveLocalHTTPSConfig(ctx, config); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	loaded, err := reopened.LoadLocalHTTPSConfig(ctx, "127.0.0.1:7331")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, config) {
		t.Fatalf("loaded config = %+v, want %+v", loaded, config)
	}
}

func TestSignInModePersists(t *testing.T) {
	ctx := context.Background()
	st, err := Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	if mode, err := st.LoadSignInMode(ctx); err != nil || mode != "" {
		t.Fatalf("unset mode = %q, %v", mode, err)
	}
	for _, want := range []string{"file", "off"} {
		if err := st.SaveSignInMode(ctx, want); err != nil {
			t.Fatal(err)
		}
		if mode, err := st.LoadSignInMode(ctx); err != nil || mode != want {
			t.Fatalf("mode = %q, %v, want %q", mode, err, want)
		}
	}
}

func TestRecoveryTokenIsMadeOnce(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := st.RecoveryToken(ctx)
	if err != nil || len(first) != 64 {
		t.Fatalf("token = %q, %v", first, err)
	}
	st.Close()
	reopened, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if again, err := reopened.RecoveryToken(ctx); err != nil || again != first {
		t.Fatalf("token after reopening = %q, %v", again, err)
	}
}
