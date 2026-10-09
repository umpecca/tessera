package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRetiredEditorAPIsAreUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	(&API{}).Register(mux)
	for _, route := range []string{"/api/file", "/api/run", "/api/runs", "/api/runs/old/events"} {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost} {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(method, route, nil))
			if w.Code != http.StatusNotFound {
				t.Fatalf("%s %s = %d", method, route, w.Code)
			}
		}
	}
}

func TestTerminalDirectoryPickerRemainsDirectoryOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "project"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("private draft"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/directories?files=1", nil)
	q := r.URL.Query()
	q.Set("path", dir)
	r.URL.RawQuery = q.Encode()
	(&API{}).listDirectories(w, r)
	var result directoryListResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusOK || len(result.Entries) != 1 || result.Entries[0].Name != "project" || result.Entries[0].Kind != "directory" {
		t.Fatalf("directory picker changed: %s", w.Body.String())
	}
}
