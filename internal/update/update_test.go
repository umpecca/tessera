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
	"strings"
	"testing"
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

func TestCheckAcceptsExecutableOnlyRelease(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"tag_name":"v999.0.0","assets":[{"name":%q,"browser_download_url":"%s/binary","size":4}]}`, assetName(), serverURL(r))
	}))
	defer server.Close()
	u := &Updater{Repo: "owner/repo", APIBase: server.URL, exePath: filepath.Join(t.TempDir(), assetName())}
	if result, err := u.Check(context.Background()); err != nil || !result.UpdateAvailable || result.assetName != assetName() {
		t.Fatalf("executable-only release: result=%+v err=%v", result, err)
	}
}

func serverURL(r *http.Request) string {
	return "http://" + r.Host
}

func TestApplyInstallsOnlyExecutableAndLeavesExistingEncoderAlone(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, assetName())
	legacyName := strings.Replace(assetName(), "tessera-", "tessera-lame-", 1)
	legacyEncoder := filepath.Join(dir, legacyName)
	for path, contents := range map[string]string{exe: "old", legacyEncoder: "user-managed encoder"} {
		if err := os.WriteFile(path, []byte(contents), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	requests := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		switch r.URL.Path {
		case "/repos/owner/repo/releases/latest":
			_, _ = fmt.Fprintf(w, `{"tag_name":"v999.0.0","assets":[{"name":%q,"browser_download_url":"%s/binary","size":3},{"name":%q,"browser_download_url":"%s/deprecated","size":1000}]}`, assetName(), serverURL(r), legacyName, serverURL(r))
		case "/binary":
			_, _ = w.Write([]byte("new"))
		default:
			t.Errorf("unexpected asset request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	u := &Updater{Repo: "owner/repo", APIBase: server.URL, exePath: exe}
	if _, err := u.Apply(context.Background()); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]string{exe: "new", legacyEncoder: "user-managed encoder"} {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Fatalf("%s: %q %v", path, got, err)
		}
	}
	if len(requests) != 2 {
		t.Fatalf("requests = %v", requests)
	}
}

func TestFailedExecutableSwapRestoresPreviousBinary(t *testing.T) {
	exe := filepath.Join(t.TempDir(), assetName())
	if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	u := &Updater{exePath: exe}
	if err := u.swap(exe + ".missing"); err == nil {
		t.Fatal("missing download succeeded")
	}
	if got, err := os.ReadFile(exe); err != nil || string(got) != "old" {
		t.Fatalf("rollback = %q %v", got, err)
	}
}
