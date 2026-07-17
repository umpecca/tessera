package server

import (
	"bytes"
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStartRejectsInvalidTrustedProxyBeforeOpeningStore(t *testing.T) {
	_, err := Start(context.Background(), Options{
		Addr:           "127.0.0.1:0",
		DBPath:         filepath.Join(t.TempDir(), "unused.sqlite3"),
		TrustedProxies: []string{"not-an-address"},
	})
	if err == nil || !strings.Contains(err.Error(), "invalid trusted proxy") {
		t.Fatalf("Start() error = %v, want invalid trusted proxy", err)
	}
}

func TestStartWiresFileUploadLimit(t *testing.T) {
	directory := t.TempDir()
	server, err := Start(context.Background(), Options{
		Addr:           "127.0.0.1:0",
		DBPath:         filepath.Join(directory, "tessera.sqlite3"),
		MaxUploadBytes: 3,
	})
	if err != nil {
		t.Fatalf("start server: %v", err)
	}
	defer server.Shutdown(context.Background())

	uploadDirectory := filepath.Join(directory, "uploads")
	if err := os.Mkdir(uploadDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	target := server.URL + "/api/files/upload?directory=" + url.QueryEscape(uploadDirectory) + "&name=large.bin"
	response, err := http.Post(target, "application/octet-stream", bytes.NewReader([]byte("1234")))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("upload status = %d, want 413", response.StatusCode)
	}
	if DefaultMaxUploadBytes != 1<<30 {
		t.Fatalf("default max upload bytes = %d", DefaultMaxUploadBytes)
	}
}
