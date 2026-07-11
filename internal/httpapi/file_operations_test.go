package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestFileOperationsCopyMoveDelete(t *testing.T) {
	root := t.TempDir()
	sourceDir := filepath.Join(root, "source")
	copyDir := filepath.Join(root, "copies")
	moveDir := filepath.Join(root, "moved")
	for _, path := range []string{sourceDir, copyDir, moveDir} {
		if err := os.Mkdir(path, 0o755); err != nil {
			t.Fatalf("create %s: %v", path, err)
		}
	}
	source := filepath.Join(sourceDir, "notes")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "one.txt"), []byte("one"), 0o644); err != nil {
		t.Fatal(err)
	}

	api := &API{}
	runFileOperation(t, api, fileOperationRequest{Action: "copy", Source: source, Destination: copyDir}, http.StatusOK)
	copied := filepath.Join(copyDir, "notes")
	if content, err := os.ReadFile(filepath.Join(copied, "one.txt")); err != nil || string(content) != "one" {
		t.Fatalf("copied content = %q, %v", content, err)
	}

	runFileOperation(t, api, fileOperationRequest{Action: "move", Source: copied, Destination: moveDir}, http.StatusOK)
	moved := filepath.Join(moveDir, "notes")
	if _, err := os.Stat(copied); !os.IsNotExist(err) {
		t.Fatalf("copied source still exists after move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(moved, "one.txt")); err != nil {
		t.Fatalf("moved file missing: %v", err)
	}

	runFileOperation(t, api, fileOperationRequest{Action: "delete", Source: moved}, http.StatusOK)
	if _, err := os.Stat(moved); !os.IsNotExist(err) {
		t.Fatalf("moved directory still exists after delete: %v", err)
	}
}

func TestFileOperationsRejectsCollisionAndNestedCopy(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "folder")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	api := &API{}

	runFileOperation(t, api, fileOperationRequest{Action: "copy", Source: source, Destination: root}, http.StatusConflict)

	nested := filepath.Join(source, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	runFileOperation(t, api, fileOperationRequest{Action: "copy", Source: source, Destination: nested}, http.StatusBadRequest)
}

func runFileOperation(t *testing.T, api *API, request fileOperationRequest, wantStatus int) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	httpRequest := httptest.NewRequest(http.MethodPost, "/api/files", bytes.NewReader(body))
	recorder := httptest.NewRecorder()
	api.fileOperations(recorder, httpRequest)
	if recorder.Code != wantStatus {
		t.Fatalf("%s status = %d, want %d; body: %s", request.Action, recorder.Code, wantStatus, recorder.Body.String())
	}
}
