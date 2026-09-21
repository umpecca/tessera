//go:build desktop

// Package nativeapp owns the additional native application's profile and host.
// Cocoa integration is compiled only with the desktop tag on macOS.
package nativeapp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"tessera/internal/server"
)

type Host struct {
	Server *server.Server
	Token  string
}

func ProfileDir() (string, error) {
	root, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("locate desktop profile: %w", err)
	}
	return filepath.Join(root, "Tessera Desktop"), nil
}

// Start keeps a stable local origin so the webview's device-local preferences
// survive relaunch. If another process owns the saved port, fail closed instead
// of loading that process's page or silently switching localStorage origins.
// The caller must hold the exclusive profile lock before calling Start.
func Start(ctx context.Context, profile string) (*Host, error) {
	if err := os.MkdirAll(profile, 0700); err != nil {
		return nil, err
	}
	portPath := filepath.Join(profile, "port")
	port := "0"
	data, err := os.ReadFile(portPath)
	if err == nil {
		port = strings.TrimSpace(string(data))
		n, parseErr := strconv.Atoi(port)
		if parseErr != nil || n < 1024 || n > 65535 {
			return nil, fmt.Errorf("invalid desktop port file %s", portPath)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(secret[:])
	srv, err := server.Start(ctx, server.Options{
		Addr: "127.0.0.1:" + port, DBPath: filepath.Join(profile, "tessera.sqlite3"),
		DesktopToken: token,
	})
	if err != nil {
		return nil, err
	}
	if port == "0" {
		_, actual, _ := net.SplitHostPort(srv.Addr)
		if err := os.WriteFile(portPath, []byte(actual+"\n"), 0600); err != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
			return nil, fmt.Errorf("save desktop origin: %w", err)
		}
	}
	return &Host{Server: srv, Token: token}, nil
}
