package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func testArchive(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	w := zip.NewWriter(&output)
	for name, data := range entries {
		file, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := file.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestRejectUnsignedMismatchedAndExtraCode(t *testing.T) {
	sources := map[string][]byte{"manifest.json": []byte(`{"version":"0.1.0"}`), "content.js": []byte("expected")}
	entries := map[string][]byte{}
	for name, data := range sources {
		entries[name] = data
	}
	if err := validateSignedPackage(testArchive(t, entries), sources); err == nil {
		t.Fatal("accepted unsigned package")
	}
	for _, name := range []string{"META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"} {
		entries[name] = []byte("fixture, not a real signature")
	}
	if err := validateSignedPackage(testArchive(t, entries), sources); err != nil {
		t.Fatal(err)
	}
	entries["extra.js"] = []byte("unexpected code")
	if err := validateSignedPackage(testArchive(t, entries), sources); err == nil {
		t.Fatal("accepted extra code")
	}
	delete(entries, "extra.js")
	entries["content.js"] = []byte("different")
	if err := validateSignedPackage(testArchive(t, entries), sources); err == nil {
		t.Fatal("accepted source mismatch")
	}
	delete(entries, "content.js")
	if err := validateSignedPackage(testArchive(t, entries), sources); err == nil {
		t.Fatal("accepted missing source")
	}
}

func TestDevelopmentPackageIsReproducibleAndNeverLabeledSigned(t *testing.T) {
	source, destination := t.TempDir(), t.TempDir()
	for _, name := range sourceFiles {
		data := []byte("test\r\n")
		if name == "manifest.json" {
			data = []byte("{\"version\":\"0.1.0\"}\r\n")
		}
		if err := os.WriteFile(filepath.Join(source, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	if err := packageExtension(source, destination, ""); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(filepath.Join(destination, "tessera-clipboard-dev.zip"))
	if err != nil {
		t.Fatal(err)
	}
	if err := packageExtension(source, destination, ""); err != nil {
		t.Fatal(err)
	}
	second, _ := os.ReadFile(filepath.Join(destination, "tessera-clipboard-dev.zip"))
	if !bytes.Equal(first, second) {
		t.Fatal("package changed without source changes")
	}
	metadata, _ := os.ReadFile(filepath.Join(destination, "firefox-clipboard.json"))
	var info struct {
		Signed  bool
		Version string
	}
	if err := json.Unmarshal(metadata, &info); err != nil {
		t.Fatal(err)
	}
	if info.Signed || info.Version != "0.1.0" {
		t.Fatalf("unexpected metadata: %+v", info)
	}
	archive, err := zip.NewReader(bytes.NewReader(first), int64(len(first)))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != len(sourceFiles) {
		t.Fatalf("unexpected package files: %d", len(archive.File))
	}
	// A stale/malformed signed artifact must stop the build, not silently be
	// distributed with metadata for different source code.
	if err := os.WriteFile(filepath.Join(destination, "tessera-clipboard.xpi"), first, 0644); err != nil {
		t.Fatal(err)
	}
	if err := packageExtension(source, destination, ""); err == nil {
		t.Fatal("accepted an unsigned XPI")
	}
}
