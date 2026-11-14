package server

import (
	"bytes"
	"context"
	"net"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"tessera/internal/auth"
	"tessera/internal/httpapi"
	"tessera/internal/localhttps"
	"tessera/internal/store"
)

func TestStartupReportsActualEndpointsAndReloads(t *testing.T) {
	ctx := context.Background()
	for _, address := range []string{"127.0.0.1:0", "[::1]:0"} {
		t.Run(address, func(t *testing.T) {
			probe, err := net.Listen("tcp", address)
			if err != nil {
				t.Skipf("listener unavailable: %v", err)
			}
			probe.Close()
			var output bytes.Buffer
			srv, err := Start(ctx, Options{Addr: address, DBPath: filepath.Join(t.TempDir(), "tessera.sqlite3"), StartupOutput: &output})
			if err != nil {
				t.Fatal(err)
			}
			defer srv.Shutdown(ctx)
			if !strings.Contains(output.String(), "HTTP:  "+srv.URL) || !strings.Contains(output.String(), "HTTPS: disabled") || strings.Contains(output.String(), ":0\n") || !strings.Contains(output.String(), "Sign-in: off") {
				t.Fatalf("summary = %s", &output)
			}
			config := localhttps.Config{Enabled: true, HTTPSAddress: address, DNSNames: []string{"localhost"}, IPAddresses: []string{"127.0.0.1", "::1"}}
			if err := srv.store.SaveLocalHTTPSConfig(ctx, config); err != nil {
				t.Fatal(err)
			}
			output.Reset()
			if err := srv.ReloadLocalHTTPS(ctx); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(output.String(), "HTTP:  "+srv.URL) || !strings.Contains(output.String(), "HTTPS: "+srv.HTTPSURL) || strings.Contains(output.String(), ":0\n") {
				t.Fatalf("reload summary = %s", &output)
			}
			output.Reset()
			config.Enabled = false
			if err := srv.store.SaveLocalHTTPSConfig(ctx, config); err != nil {
				t.Fatal(err)
			}
			if err := srv.ReloadLocalHTTPS(ctx); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(output.String(), "HTTPS: disabled") {
				t.Fatalf("disable summary = %s", &output)
			}
		})
	}
}

func TestRuntimeSignInDoesNotPersistAndSummaryHasNoSecrets(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "tessera.sqlite3")
	st, err := store.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	hash, _ := auth.HashPassword([]byte("saved-password"))
	before := []auth.Account{{Name: "saved", Hash: hash, Admin: true}}
	if err := st.UpdateAccounts(ctx, func([]auth.Account) ([]auth.Account, error) { return before, nil }); err != nil {
		t.Fatal(err)
	}
	if err := st.SaveSignInMode(ctx, httpapi.AuthSystem); err != nil {
		t.Fatal(err)
	}
	st.Close()
	cliHash, _ := auth.HashPassword([]byte("runtime-password"))
	var output bytes.Buffer
	srv, err := Start(ctx, Options{Addr: "127.0.0.1:0", DBPath: path, StartupOutput: &output,
		Auth: httpapi.AuthOptions{RuntimeAccount: &auth.Account{Name: "cli", Hash: cliHash, Admin: true}}})
	if err != nil {
		t.Fatal(err)
	}
	defer srv.Shutdown(ctx)
	mode, _ := srv.store.LoadSignInMode(ctx)
	after, _ := srv.store.Accounts(ctx)
	if mode != httpapi.AuthSystem || !reflect.DeepEqual(before, after) {
		t.Fatal("override changed saved state")
	}
	if !strings.Contains(output.String(), `CLI account "cli"`) || !strings.Contains(output.String(), "saved accounts inactive") {
		t.Fatalf("summary = %s", &output)
	}
	for _, secret := range []string{hash, cliHash, "runtime-password", "saved-password", auth.CredentialTag(cliHash)} {
		if strings.Contains(output.String(), secret) {
			t.Fatal("summary disclosed credentials")
		}
	}
	// Dropping the override picks the original saved mode without locking it.
	options := httpapi.AuthOptions{SystemAccount: "host"}
	if err := resolveSignIn(ctx, srv.store, &options); err != nil || options.Mode != httpapi.AuthSystem || options.ModeLocked {
		t.Fatalf("restore = %s, %v", options.Mode, err)
	}
}

func TestFailedStartupEmitsNoEndpointSummary(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var output bytes.Buffer
	_, err = Start(context.Background(), Options{Addr: listener.Addr().String(), DBPath: filepath.Join(t.TempDir(), "tessera.sqlite3"), StartupOutput: &output})
	if err == nil || output.Len() != 0 {
		t.Fatalf("failed start: err=%v, output=%s", err, &output)
	}
}

func TestStartupSummaryNamesOnlyTheEffectiveSavedAccounts(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	hash, _ := auth.HashPassword([]byte("saved-secret"))
	if err := st.UpdateAccounts(ctx, func([]auth.Account) ([]auth.Account, error) {
		return []auth.Account{{Name: "alice", Hash: hash, Admin: true}, {Name: "bob", Hash: hash}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ mode, want string }{
		{httpapi.AuthOff, "Sign-in: off"},
		{httpapi.AuthFile, `Tessera accounts: "alice", "bob"`},
		{httpapi.AuthSystem, `host account "host"`},
	} {
		if err := st.SaveSignInMode(ctx, test.mode); err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		srv := &Server{URL: "http://127.0.0.1:7331", store: st, startupOutput: &output,
			auth: httpapi.AuthOptions{Mode: httpapi.AuthOff, SystemAccount: "host"}}
		srv.reportStartup()
		if !strings.Contains(output.String(), test.want) || strings.Contains(output.String(), hash) || strings.Contains(output.String(), "saved-secret") {
			t.Fatalf("summary = %s", &output)
		}
	}
}
