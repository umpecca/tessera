package update

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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
