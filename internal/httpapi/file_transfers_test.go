package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUploadFileStagesConflictsAndOverwrites(t *testing.T) {
	directory := t.TempDir()
	api := &API{MaxUploadBytes: 64}

	response := runUpload(t, api, directory, "notes.txt", false, []byte("first"), false)
	if response.Code != http.StatusCreated {
		t.Fatalf("first upload = %d: %s", response.Code, response.Body.String())
	}
	path := filepath.Join(directory, "notes.txt")
	if content, err := os.ReadFile(path); err != nil || string(content) != "first" {
		t.Fatalf("first content = %q, %v", content, err)
	}

	response = runUpload(t, api, directory, "notes.txt", false, []byte("second"), false)
	if response.Code != http.StatusConflict {
		t.Fatalf("conflict upload = %d: %s", response.Code, response.Body.String())
	}
	if content, _ := os.ReadFile(path); string(content) != "first" {
		t.Fatalf("conflict changed content to %q", content)
	}

	response = runUpload(t, api, directory, "notes.txt", true, []byte("second"), false)
	if response.Code != http.StatusCreated {
		t.Fatalf("overwrite upload = %d: %s", response.Code, response.Body.String())
	}
	if content, err := os.ReadFile(path); err != nil || string(content) != "second" {
		t.Fatalf("overwritten content = %q, %v", content, err)
	}
	assertNoTransferTemporaryFiles(t, directory)
}

func TestUploadFileEnforcesStreamLimitAndCleansTemporaryFile(t *testing.T) {
	directory := t.TempDir()
	api := &API{MaxUploadBytes: 4}
	response := runUpload(t, api, directory, "large.bin", false, []byte("12345"), true)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized upload = %d: %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(directory, "large.bin")); !os.IsNotExist(err) {
		t.Fatalf("oversized destination exists: %v", err)
	}
	assertNoTransferTemporaryFiles(t, directory)
}

func TestUploadFileRejectsUnsafeNamesAndDestinations(t *testing.T) {
	directory := t.TempDir()
	api := &API{MaxUploadBytes: 64}
	for _, name := range []string{"", ".", "..", "nested/file", `nested\file`, filepath.Join(directory, "absolute.txt")} {
		response := runUpload(t, api, directory, name, false, []byte("content"), false)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("name %q status = %d, want 400", name, response.Code)
		}
	}

	targetDirectory := filepath.Join(directory, "folder")
	if err := os.Mkdir(targetDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	response := runUpload(t, api, directory, "folder", true, []byte("content"), false)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("directory target status = %d, want 400", response.Code)
	}
	assertNoTransferTemporaryFiles(t, directory)
}

func runUpload(t *testing.T, api *API, directory, name string, overwrite bool, content []byte, unknownLength bool) *httptest.ResponseRecorder {
	t.Helper()
	target := "/api/files/upload?directory=" + url.QueryEscape(directory) + "&name=" + url.QueryEscape(name)
	if overwrite {
		target += "&overwrite=1"
	}
	request := httptest.NewRequest(http.MethodPost, target, bytes.NewReader(content))
	if unknownLength {
		request.ContentLength = -1
	}
	response := httptest.NewRecorder()
	api.uploadFile(response, request)
	return response
}

func assertNoTransferTemporaryFiles(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tessera-upload-") || strings.HasPrefix(entry.Name(), ".tessera-replaced-") {
			t.Fatalf("temporary transfer file remains: %s", entry.Name())
		}
	}
}
