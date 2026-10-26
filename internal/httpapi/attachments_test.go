package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestAttachmentNamesAreUniqueAndShellSafe(t *testing.T) {
	now := time.Date(2026, 10, 26, 15, 30, 12, 0, time.UTC)
	for original, want := range map[string]string{
		"IMG_0001.jpeg":                  `^20261026-153012-[0-9a-f]{4}-IMG_0001\.jpeg$`,
		"Screen Shot 2026 (1).PNG":       `^20261026-153012-[0-9a-f]{4}-Screen-Shot-2026-1\.png$`,
		"../../etc/passwd":               `^20261026-153012-[0-9a-f]{4}-passwd\.bin$`,
		`C:\photos\cat.heic`:             `^20261026-153012-[0-9a-f]{4}-cat\.heic$`,
		"":                               `^20261026-153012-[0-9a-f]{4}-image\.bin$`,
		"$(rm -rf ~).png":                `^20261026-153012-[0-9a-f]{4}-rm-rf\.png$`,
		strings.Repeat("a", 90) + ".jpg": `^20261026-153012-[0-9a-f]{4}-a{40}\.jpg$`,
	} {
		if got := attachmentName(original, now); !regexp.MustCompile(want).MatchString(got) {
			t.Errorf("attachmentName(%q) = %q, want %s", original, got, want)
		}
	}
	if attachmentName("a.png", now) == attachmentName("a.png", now) {
		t.Error("two attachments in the same second share a name")
	}
}

func TestUploadAttachmentKeepsTheImageAndPrunesOldOnes(t *testing.T) {
	directory := t.TempDir()
	saved := attachmentDirectory
	attachmentDirectory = func() (string, error) { return directory, nil }
	t.Cleanup(func() { attachmentDirectory = saved })
	old := filepath.Join(directory, "old.png")
	if err := os.WriteFile(old, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	stale := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(old, stale, stale); err != nil {
		t.Fatal(err)
	}
	api := &API{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/host/attachments", api.uploadAttachment)
	image := []byte("\x89PNG\r\n\x1a\nnot really")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/host/attachments?name=photo.png", bytes.NewReader(image)))
	if response.Code != http.StatusCreated {
		t.Fatalf("status %d: %s", response.Code, response.Body)
	}
	var result map[string]string
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(result["path"]) != directory || !strings.HasSuffix(result["path"], "-photo.png") || len(result) != 1 {
		t.Fatalf("result = %v", result)
	}
	if data, err := os.ReadFile(result["path"]); err != nil || !bytes.Equal(data, image) {
		t.Fatalf("saved %q, %v", data, err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("a week-old attachment is still there: %v", err)
	}

	api.MaxUploadBytes = 4
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/host/attachments?name=big.png", bytes.NewReader(image)))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d %s", response.Code, response.Body)
	}
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/host/attachments", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET: %d", response.Code)
	}
}

func TestAttachmentDirectoryIsPrivateToTheAccount(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CACHE_HOME", filepath.Join(os.Getenv("HOME"), ".cache"))
	t.Setenv("LocalAppData", filepath.Join(os.Getenv("HOME"), "AppData"))
	directory, err := attachmentDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(directory, os.Getenv("HOME")) || filepath.Base(directory) != "attachments" {
		t.Fatalf("directory = %q", directory)
	}
	if info, err := os.Stat(directory); err != nil || (info.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/') {
		t.Fatalf("mode = %v, %v", info.Mode(), err)
	}
}
