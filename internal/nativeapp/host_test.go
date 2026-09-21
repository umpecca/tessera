//go:build desktop

package nativeapp

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestProfileOriginPersistsButCredentialRotates(t *testing.T) {
	profile := t.TempDir()
	first, err := Start(context.Background(), profile)
	if err != nil {
		t.Fatal(err)
	}
	url, token := first.Server.URL, first.Token
	if err := first.Server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	second, err := Start(context.Background(), profile)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Server.Shutdown(context.Background())
	if second.Server.URL != url {
		t.Fatal("desktop origin changed on relaunch")
	}
	if second.Token == token {
		t.Fatal("credential did not rotate")
	}
	data, err := os.ReadFile(filepath.Join(profile, "port"))
	if err != nil || string(data) == "" {
		t.Fatalf("port not persisted: %v", err)
	}
}

func TestProfilePortConflictFailsClosed(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	profile := t.TempDir()
	if err := os.WriteFile(filepath.Join(profile, "port"), []byte(port), 0600); err != nil {
		t.Fatal(err)
	}
	if host, err := Start(context.Background(), profile); err == nil {
		host.Server.Shutdown(context.Background())
		t.Fatal("desktop reused an occupied origin")
	}
}

func TestInvalidProfilePortRejected(t *testing.T) {
	for _, value := range []string{"0", "80", "65536", "7331\n7332", "../bad"} {
		profile := t.TempDir()
		if err := os.WriteFile(filepath.Join(profile, "port"), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		if host, err := Start(context.Background(), profile); err == nil {
			host.Server.Shutdown(context.Background())
			t.Fatalf("invalid port %q accepted", value)
		}
	}
}
