// Package the Firefox extension with the Go standard library, so release
// builds need no separate ZIP utility or additional npm dependency.
package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

var sourceFiles = []string{"manifest.json", "policy.js", "background.js", "content.js", "popup.html", "popup.css", "popup.js"}

func main() {
	signed := flag.String("signed", "", "Mozilla-signed XPI to bundle (must match current extension sources)")
	flag.Parse()
	if err := packageExtension("extensions/firefox-clipboard", "web/extensions", *signed); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func packageExtension(source, destination, signedPath string) error {
	files := make(map[string][]byte)
	for _, name := range sourceFiles {
		data, err := os.ReadFile(filepath.Join(source, name))
		if err != nil {
			return err
		}
		// Reproducible across Git checkouts with different line endings.
		files[name] = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	}
	var manifest struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil {
		return err
	}
	if manifest.Version == "" {
		return fmt.Errorf("extension version is missing")
	}
	var development bytes.Buffer
	writer := zip.NewWriter(&development)
	for _, name := range sourceFiles {
		header := &zip.FileHeader{Name: name, Method: zip.Deflate}
		header.SetModTime(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
		header.SetMode(0644)
		entry, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		if _, err = entry.Write(files[name]); err != nil {
			return err
		}
	}
	if err := writer.Close(); err != nil {
		return err
	}
	installed := filepath.Join(destination, "tessera-clipboard.xpi")
	if signedPath == "" {
		if _, err := os.Stat(installed); err == nil {
			signedPath = installed
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	var signedData []byte
	if signedPath != "" {
		var err error
		signedData, err = os.ReadFile(signedPath)
		if err != nil {
			return err
		}
		if err = validateSignedPackage(signedData, files); err != nil {
			return fmt.Errorf("signed package rejected: %w; obtain a new signed XPI matching the current sources", err)
		}
	}
	if err := os.MkdirAll(destination, 0755); err != nil {
		return err
	}
	if err := writePackageFile(filepath.Join(destination, "tessera-clipboard-dev.zip"), development.Bytes()); err != nil {
		return err
	}
	if signedData != nil {
		if err := writePackageFile(installed, signedData); err != nil {
			return err
		}
	}
	metadata, err := json.MarshalIndent(struct {
		Version string `json:"version"`
		Signed  bool   `json:"signed"`
	}{manifest.Version, signedData != nil}, "", "  ")
	if err != nil {
		return err
	}
	return writePackageFile(filepath.Join(destination, "firefox-clipboard.json"), append(metadata, '\n'))
}

func writePackageFile(name string, data []byte) error {
	// Firefox can memory-map a temporarily installed ZIP on Windows. Avoid
	// rewriting unchanged bytes (and unnecessary source-control timestamps).
	if current, err := os.ReadFile(name); err == nil && bytes.Equal(current, data) {
		return nil
	}
	return os.WriteFile(name, data, 0644)
}

// This checks package identity/source integrity and the presence of Mozilla
// signing files. Firefox performs cryptographic signature verification during
// installation; this tool must only be given an XPI returned by Mozilla.
func validateSignedPackage(data []byte, sources map[string][]byte) error {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	seen := make(map[string]bool)
	for _, entry := range archive.File {
		if seen[entry.Name] {
			return fmt.Errorf("duplicate entry %s", entry.Name)
		}
		seen[entry.Name] = true
		if expected, ok := sources[entry.Name]; ok {
			file, err := entry.Open()
			if err != nil {
				return err
			}
			content, err := io.ReadAll(io.LimitReader(file, int64(len(expected))+1))
			file.Close()
			if err != nil {
				return err
			}
			if !bytes.Equal(content, expected) {
				return fmt.Errorf("source mismatch: %s", entry.Name)
			}
		} else if entry.Name != "META-INF/" && entry.Name != "META-INF/manifest.mf" && entry.Name != "META-INF/mozilla.sf" && entry.Name != "META-INF/mozilla.rsa" && entry.Name != "META-INF/cose.manifest" && entry.Name != "META-INF/cose.sig" {
			return fmt.Errorf("unexpected entry %s", entry.Name)
		}
	}
	for name := range sources {
		if !seen[name] {
			return fmt.Errorf("missing source %s", name)
		}
	}
	for _, name := range []string{"META-INF/manifest.mf", "META-INF/mozilla.sf", "META-INF/mozilla.rsa"} {
		if !seen[name] {
			return fmt.Errorf("missing signing file %s", name)
		}
	}
	return nil
}
