package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func saveHostFileRequest(t *testing.T, directory, name, body string, overwrite bool) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	(&API{}).Register(mux)
	query := url.Values{"directory": {directory}, "name": {name}}
	if overwrite {
		query.Set("overwrite", "1")
	}
	request := httptest.NewRequest(http.MethodPost, "/api/host/files?"+query.Encode(), strings.NewReader(body))
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	return response
}

func TestSaveHostFileWritesAndAsksBeforeReplacing(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "clipboard.txt")
	if response := saveHostFileRequest(t, directory, "clipboard.txt", "first", false); response.Code != http.StatusCreated {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	if response := saveHostFileRequest(t, directory, "clipboard.txt", "second", false); response.Code != http.StatusConflict {
		t.Fatalf("existing file without overwrite: %d", response.Code)
	}
	if data, _ := os.ReadFile(target); string(data) != "first" {
		t.Fatalf("conflict changed the file: %q", data)
	}
	if response := saveHostFileRequest(t, directory, "clipboard.txt", "second", true); response.Code != http.StatusCreated {
		t.Fatalf("overwrite: %d %s", response.Code, response.Body.String())
	}
	if data, _ := os.ReadFile(target); string(data) != "second" {
		t.Fatalf("overwrite left %q", data)
	}
	entries, _ := os.ReadDir(directory)
	if len(entries) != 1 {
		t.Fatalf("staging files left behind: %v", entries)
	}
}

func TestSaveHostFileRefusesPathsAndSymlinks(t *testing.T) {
	directory := t.TempDir()
	for _, name := range []string{"", "..", "../escape.txt", "sub/name.txt", filepath.Join(directory, "abs.txt")} {
		if response := saveHostFileRequest(t, directory, name, "x", true); response.Code != http.StatusBadRequest {
			t.Errorf("name %q: %d", name, response.Code)
		}
	}
	if response := saveHostFileRequest(t, filepath.Join(directory, "missing"), "a.txt", "x", false); response.Code != http.StatusBadRequest {
		t.Errorf("missing directory: %d", response.Code)
	}
	if runtime.GOOS == "windows" {
		return
	}
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if response := saveHostFileRequest(t, directory, "link.txt", "replaced", true); response.Code != http.StatusBadRequest {
		t.Fatalf("symlink target: %d", response.Code)
	}
	if data, _ := os.ReadFile(outside); string(data) != "keep" {
		t.Fatalf("wrote through the symlink: %q", data)
	}
}

func TestDeleteHostFilesRemovesOnlyUnchangedFilesItSaved(t *testing.T) {
	directory := t.TempDir()
	mux := http.NewServeMux()
	(&API{}).Register(mux)
	save := func(name, body string) string {
		query := url.Values{"directory": {directory}, "name": {name}}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/host/files?"+query.Encode(), strings.NewReader(body)))
		if response.Code != http.StatusCreated {
			t.Fatalf("save %s: %d %s", name, response.Code, response.Body.String())
		}
		return filepath.Join(directory, name)
	}
	remove := func(paths ...string) deleteHostFilesResult {
		body, _ := json.Marshal(map[string][]string{"paths": paths})
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/host/files/delete", bytes.NewReader(body)))
		if response.Code != http.StatusOK {
			t.Fatalf("delete: %d %s", response.Code, response.Body.String())
		}
		var result deleteHostFilesResult
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}

	saved := save("clipboard.txt", "hello")
	edited := save("clipboard.png", "png")
	other := filepath.Join(directory, "mine.txt")
	if err := os.WriteFile(other, []byte("not Tessera's"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Edited after the save: a different size, so it no longer matches.
	if err := os.WriteFile(edited, []byte("changed by a program"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := remove(saved, edited, other)
	if len(result.Deleted) != 1 || result.Deleted[0] != saved || len(result.Kept) != 2 {
		t.Fatalf("result %+v", result)
	}
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Fatalf("saved file still there: %v", err)
	}
	for _, path := range []string{edited, other} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s was deleted", path)
		}
	}
	// A second delete finds nothing more of Tessera's to remove.
	if again := remove(saved); len(again.Deleted) != 0 {
		t.Fatalf("deleted twice: %+v", again)
	}
}
