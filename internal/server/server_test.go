package server

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"tessera/internal/localhttps"
	"tessera/internal/store"
	"tessera/internal/terminal"
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

func TestStartReportsPortConflict(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	_, err = Start(context.Background(), Options{
		Addr:   listener.Addr().String(),
		DBPath: filepath.Join(t.TempDir(), "tessera.sqlite3"),
	})
	if err == nil || !strings.Contains(err.Error(), "port conflict") || !strings.Contains(err.Error(), "already in use") {
		t.Fatalf("Start() error = %v, want clear port conflict", err)
	}
}

func TestStartUsesPersistedLocalHTTPSConfiguration(t *testing.T) {
	directory := t.TempDir()
	databasePath := filepath.Join(directory, "tessera.sqlite3")
	st, err := store.Open(context.Background(), databasePath)
	if err != nil {
		t.Fatal(err)
	}
	config := localhttps.Config{
		Enabled: true, HTTPSAddress: "127.0.0.1:0",
		DNSNames: []string{"localhost"}, IPAddresses: []string{"127.0.0.1"},
	}
	if err := st.SaveLocalHTTPSConfig(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}

	srv, err := Start(context.Background(), Options{
		Addr: "127.0.0.1:7331", DBPath: databasePath,
	})
	if err != nil {
		t.Fatalf("start HTTPS server: %v", err)
	}
	defer srv.Shutdown(context.Background())
	if !strings.HasPrefix(srv.URL, "http://") || !strings.HasPrefix(srv.HTTPSURL, "https://localhost:") {
		t.Fatalf("server URLs = HTTP %q, HTTPS %q", srv.URL, srv.HTTPSURL)
	}
	httpResponse, err := http.Get(srv.URL + "/api/health")
	if err != nil {
		t.Fatalf("HTTP health request: %v", err)
	}
	if closeErr := httpResponse.Body.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if httpResponse.StatusCode != http.StatusOK {
		t.Fatalf("HTTP health status = %d, want 200", httpResponse.StatusCode)
	}
	rootPEM, err := localhttps.ReadRootPEM(filepath.Join(directory, "pki"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootPEM) {
		t.Fatal("could not trust generated root")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12,
	}}}
	response, err := client.Get(srv.HTTPSURL + "/api/health")
	if err != nil {
		t.Fatalf("HTTPS health request: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"status":"ok"`)) {
		t.Fatalf("health response = %d, %s", response.StatusCode, body)
	}
}

func TestReloadLocalHTTPSPreservesTerminalManager(t *testing.T) {
	directory := t.TempDir()
	srv, err := Start(context.Background(), Options{
		Addr:   "127.0.0.1:0",
		DBPath: filepath.Join(directory, "tessera.sqlite3"),
	})
	if err != nil {
		t.Fatalf("start HTTP server: %v", err)
	}
	defer srv.Shutdown(context.Background())

	terminalManager := srv.terminals
	session, attachment, err := terminalManager.Attach("workspace", "pane", "", "", 80, 24, terminal.Cursor{})
	if err != nil {
		t.Fatalf("start terminal before listener reload: %v", err)
	}
	defer attachment.Unsubscribe()
	config := localhttps.Config{
		Enabled: true, HTTPSAddress: "127.0.0.1:0",
		DNSNames: []string{"localhost"}, IPAddresses: []string{"127.0.0.1"},
	}
	if err := srv.store.SaveLocalHTTPSConfig(context.Background(), config); err != nil {
		t.Fatal(err)
	}
	if err := srv.ReloadLocalHTTPS(context.Background()); err != nil {
		t.Fatalf("reload HTTPS listeners: %v", err)
	}
	if srv.terminals != terminalManager {
		t.Fatal("listener reload replaced the terminal manager")
	}
	if _, err := session.Write([]byte("echo tessera-reload-ok\r\n")); err != nil {
		t.Fatalf("write to terminal after listener reload: %v", err)
	}
	if !strings.HasPrefix(srv.URL, "http://") || !strings.HasPrefix(srv.HTTPSURL, "https://localhost:") {
		t.Fatalf("server URLs = HTTP %q, HTTPS %q", srv.URL, srv.HTTPSURL)
	}

	rootPEM, err := localhttps.ReadRootPEM(filepath.Join(directory, "pki"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(rootPEM) {
		t.Fatal("could not trust generated root")
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		RootCAs: roots, ServerName: "localhost", MinVersion: tls.VersionTLS12,
	}}}
	response, err := client.Get(srv.HTTPSURL + "/api/health")
	if err != nil {
		t.Fatalf("HTTPS health request after reload: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health status after reload = %d, want 200", response.StatusCode)
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
