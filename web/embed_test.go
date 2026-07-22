package web

import (
	"encoding/json"
	"image/png"
	"io/fs"
	"strings"
	"testing"
)

func TestTopLevelBrowserAssetsAreEmbedded(t *testing.T) {
	for _, name := range []string{"manifest.webmanifest", "browser-pane.mjs", "oled-border-size.mjs", "terminal-keyboard.mjs", "workspace-concurrency.mjs"} {
		if _, err := fs.Stat(Files, name); err != nil {
			t.Errorf("embedded asset %q: %v", name, err)
		}
	}
}

func TestWebAppIconAssets(t *testing.T) {
	expectedSizes := map[string]int{
		"assets/tessera-app-icon-180.png":          180,
		"assets/tessera-app-icon-192.png":          192,
		"assets/tessera-app-icon-512.png":          512,
		"assets/tessera-app-icon-maskable-512.png": 512,
	}
	for name, expectedSize := range expectedSizes {
		file, err := Files.Open(name)
		if err != nil {
			t.Errorf("open embedded icon %q: %v", name, err)
			continue
		}
		config, err := png.DecodeConfig(file)
		file.Close()
		if err != nil {
			t.Errorf("decode embedded icon %q: %v", name, err)
			continue
		}
		if config.Width != expectedSize || config.Height != expectedSize {
			t.Errorf("icon %q dimensions = %dx%d, want %dx%d", name, config.Width, config.Height, expectedSize, expectedSize)
		}
	}

	index, err := fs.ReadFile(Files, "index.html")
	if err != nil {
		t.Fatalf("read embedded index: %v", err)
	}
	for _, name := range []string{"tessera-app-icon-180.png", "tessera-app-icon-192.png"} {
		if !strings.Contains(string(index), name) {
			t.Errorf("index.html does not reference %q", name)
		}
	}

	manifestBytes, err := fs.ReadFile(Files, "manifest.webmanifest")
	if err != nil {
		t.Fatalf("read embedded manifest: %v", err)
	}
	var manifest struct {
		Icons []struct {
			Source  string `json:"src"`
			Purpose string `json:"purpose"`
		} `json:"icons"`
	}
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	wantedIcons := map[string]string{
		"/assets/tessera-app-icon-192.png":          "any",
		"/assets/tessera-app-icon-512.png":          "any",
		"/assets/tessera-app-icon-maskable-512.png": "maskable",
	}
	for _, icon := range manifest.Icons {
		if purpose, ok := wantedIcons[icon.Source]; ok && icon.Purpose == purpose {
			delete(wantedIcons, icon.Source)
		}
	}
	for name := range wantedIcons {
		t.Errorf("manifest is missing icon %q", name)
	}
}
