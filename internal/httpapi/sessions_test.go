package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"tessera/internal/store"
)

func TestSessionAPIAndUserSettings(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	api := &API{Store: st, Users: []string{"alice", "bob"}}
	mux := http.NewServeMux()
	api.Register(mux)

	request := func(method, path string, body any) *httptest.ResponseRecorder {
		var encoded bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&encoded).Encode(body); err != nil {
				t.Fatalf("encode request: %v", err)
			}
		}
		req := httptest.NewRequest(method, path, &encoded)
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, req)
		return response
	}

	response := request(http.MethodGet, "/api/users/alice/sessions", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("list sessions status = %d, body = %s", response.Code, response.Body.String())
	}
	var listed struct {
		Sessions []store.Session `json:"sessions"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil || len(listed.Sessions) != 1 {
		t.Fatalf("initial sessions = %+v, %v", listed, err)
	}

	response = request(http.MethodPost, "/api/users/alice/sessions", map[string]string{"name": "Work"})
	if response.Code != http.StatusCreated {
		t.Fatalf("create session status = %d, body = %s", response.Code, response.Body.String())
	}
	var created store.Session
	if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode created session: %v", err)
	}
	response = request(http.MethodPatch, "/api/users/bob/sessions/"+created.ID, map[string]string{"name": "Stolen"})
	if response.Code != http.StatusNotFound {
		t.Fatalf("cross-user rename status = %d, body = %s", response.Code, response.Body.String())
	}
	response = request(http.MethodPatch, "/api/users/alice/sessions/"+created.ID, map[string]string{"name": "Project"})
	if response.Code != http.StatusOK {
		t.Fatalf("rename session status = %d, body = %s", response.Code, response.Body.String())
	}
	response = request(http.MethodDelete, "/api/users/alice/sessions/"+created.ID, nil)
	if response.Code != http.StatusNoContent {
		t.Fatalf("delete session status = %d, body = %s", response.Code, response.Body.String())
	}
	response = request(http.MethodDelete, "/api/users/alice/sessions/"+listed.Sessions[0].ID, nil)
	if response.Code != http.StatusConflict {
		t.Fatalf("delete final session status = %d, body = %s", response.Code, response.Body.String())
	}

	settings := map[string]any{
		"defaultPaneFontSize": 18, "defaultTheme": "studio", "themeId": "hacker",
		"deskbarButtonEnabled": false, "terminalWheelSensitivity": 0.5,
		"editorWheelSensitivity": 2.0,
	}
	response = request(http.MethodPut, "/api/users/alice/settings", settings)
	if response.Code != http.StatusOK {
		t.Fatalf("save settings status = %d, body = %s", response.Code, response.Body.String())
	}
	response = request(http.MethodGet, "/api/users/alice/settings", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("load settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var loadedSettings store.UserSettings
	if err := json.Unmarshal(response.Body.Bytes(), &loadedSettings); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if loadedSettings.DeskbarButtonEnabled {
		t.Fatalf("deskbar button setting was not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalWheelSensitivity != 0.5 || loadedSettings.EditorWheelSensitivity != 2 {
		t.Fatalf("wheel sensitivity settings were not persisted: %+v", loadedSettings)
	}
}
