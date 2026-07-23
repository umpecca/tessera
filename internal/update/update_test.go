package update

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"tessera/internal/version"
)

func TestNormalizeVersion(t *testing.T) {
	cases := map[string]string{
		"v1.2.3":  "1.2.3",
		"1.2.3":   "1.2.3",
		" v0.1.0": "0.1.0",
		"dev":     "dev",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Errorf("normalizeVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAssetName(t *testing.T) {
	want := fmt.Sprintf("tessera-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if got := assetName(); got != want {
		t.Errorf("assetName() = %q, want %q", got, want)
	}
}

func TestCompanionAssetName(t *testing.T) {
	want := fmt.Sprintf("tessera-lame-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		want += ".exe"
	}
	if got := companionAssetName(); got != want {
		t.Errorf("companionAssetName() = %q, want %q", got, want)
	}
}

func TestReplacementReadinessSignals(t *testing.T) {
	readyPath := filepath.Join(t.TempDir(), "ready")
	t.Setenv(replacementReadyEnvironment, readyPath)
	if err := SignalReplacementReady(); err != nil {
		t.Fatalf("signal ready: %v", err)
	}
	marker, err := os.ReadFile(readyPath)
	if err != nil {
		t.Fatalf("read ready marker: %v", err)
	}
	if string(marker) != "ready\n" {
		t.Fatalf("ready marker = %q", marker)
	}
	if got := os.Getenv(replacementReadyEnvironment); got != "" {
		t.Fatalf("%s remained set to %q", replacementReadyEnvironment, got)
	}
}

func TestReplacementFailureSignalIncludesStartupError(t *testing.T) {
	readyPath := filepath.Join(t.TempDir(), "failure")
	t.Setenv(replacementReadyEnvironment, readyPath)
	if err := SignalReplacementFailure(errors.New("listen address unavailable")); err != nil {
		t.Fatalf("signal failure: %v", err)
	}
	marker, err := os.ReadFile(readyPath)
	if err != nil {
		t.Fatalf("read failure marker: %v", err)
	}
	if string(marker) != "error\nlisten address unavailable\n" {
		t.Fatalf("failure marker = %q", marker)
	}
}

func TestSwap(t *testing.T) {
	dir := t.TempDir()
	exePath := filepath.Join(dir, "tessera")
	if runtime.GOOS == "windows" {
		exePath += ".exe"
	}
	newPath := exePath + ".new"
	if err := os.WriteFile(exePath, []byte("old binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(newPath, []byte("new binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	u := &Updater{exePath: exePath}
	if err := u.swap(newPath); err != nil {
		t.Fatalf("swap: %v", err)
	}

	got, err := os.ReadFile(exePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new binary" {
		t.Errorf("executable contents = %q, want %q", got, "new binary")
	}
	if _, err := os.Stat(newPath); !os.IsNotExist(err) {
		t.Errorf(".new file still present (err=%v)", err)
	}
	if runtime.GOOS == "windows" {
		old, err := os.ReadFile(exePath + ".old")
		if err != nil {
			t.Fatalf("read .old: %v", err)
		}
		if string(old) != "old binary" {
			t.Errorf(".old contents = %q, want %q", old, "old binary")
		}
		u.CleanupOld()
		if _, err := os.Stat(exePath + ".old"); !os.IsNotExist(err) {
			t.Errorf(".old file still present after CleanupOld (err=%v)", err)
		}
	}
}

func TestInstallPairRollsBackCompanionOnExecutableFailure(t *testing.T) {
	if !needsCompanion() {
		t.Skip("this platform does not install an encoder companion")
	}
	dir := t.TempDir()
	exePath := filepath.Join(dir, assetName())
	companionPath := filepath.Join(dir, companionAssetName())
	companionNew := companionPath + ".new"
	if err := os.WriteFile(exePath, []byte("old executable"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(companionPath, []byte("old companion"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(companionNew, []byte("new companion"), 0o755); err != nil {
		t.Fatal(err)
	}
	u := &Updater{exePath: exePath}
	if err := u.installPair(exePath+".missing", companionNew); err == nil {
		t.Fatal("installPair succeeded with a missing executable download")
	}
	for path, want := range map[string]string{exePath: "old executable", companionPath: "old companion"} {
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("%s = %q, want %q", path, got, want)
		}
	}
}

func TestCheckRequiresCompanionAsset(t *testing.T) {
	if !needsCompanion() {
		t.Skip("this platform does not install an encoder companion")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tag_name":"v999.0.0","assets":[{"name":%q,"browser_download_url":"%s/binary","size":4}]}`, assetName(), serverURL(r))
	}))
	defer server.Close()
	u := &Updater{Repo: "owner/repo", APIBase: server.URL, exePath: filepath.Join(t.TempDir(), assetName())}
	if _, err := u.Check(context.Background()); err == nil {
		t.Fatal("Check accepted a release without the LAME companion")
	}
}

func TestEnsureCompanionBootstrapsExactRelease(t *testing.T) {
	if !needsCompanion() {
		t.Skip("this platform does not install an encoder companion")
	}
	previousVersion := version.Version
	version.Version = "v1.2.3"
	defer func() { version.Version = previousVersion }()
	payload := []byte("pinned lame companion")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/asset" {
			_, _ = w.Write(payload)
			return
		}
		if r.URL.Path != "/repos/owner/repo/releases/tags/v1.2.3" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tag_name":"v1.2.3","assets":[{"name":%q,"browser_download_url":"%s/asset","size":%d}]}`,
			companionAssetName(), serverURL(r), len(payload))
	}))
	defer server.Close()
	dir := t.TempDir()
	u := &Updater{Repo: "owner/repo", APIBase: server.URL, exePath: filepath.Join(dir, assetName())}
	if err := u.EnsureCompanion(context.Background()); err != nil {
		t.Fatalf("EnsureCompanion: %v", err)
	}
	got, err := os.ReadFile(u.companionPath())
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("companion = %q, want %q", got, payload)
	}
}

func serverURL(r *http.Request) string {
	return "http://" + r.Host
}
