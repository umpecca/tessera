package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"tessera/internal/rdpsession"
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
		"interfaceFontSize":    16,
		"phone":                map[string]any{"interfaceFontSize": 14, "defaultPaneFontSize": 13},
		"deskbarButtonEnabled": false, "terminalWheelSensitivity": 0.5,
		"oledWindowBorderSize": 16,
		"terminalTerm":         "xterm-ghostty", "terminalFont": "fira-code",
		"terminalColorMode":  "light",
		"terminalRowSpacing": "comfortable",
		"olderMacMode":       true,
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
	if loadedSettings.InterfaceFontSize != 16 || loadedSettings.DefaultPaneFontSize != 18 || loadedSettings.Phone == nil || loadedSettings.Phone.InterfaceFontSize != 14 || loadedSettings.Phone.DefaultPaneFontSize != 13 {
		t.Fatalf("independent interface and terminal sizes were not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalWheelSensitivity != 0.5 {
		t.Fatalf("wheel sensitivity settings were not persisted: %+v", loadedSettings)
	}
	if loadedSettings.OLEDWindowBorderSize != 16 {
		t.Fatalf("OLED window border size was not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalTERM != "xterm-ghostty" {
		t.Fatalf("terminal TERM setting was not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalFont != "fira-code" {
		t.Fatalf("terminal font setting was not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalRowSpacing != "comfortable" {
		t.Fatalf("terminal row spacing setting was not persisted: %+v", loadedSettings)
	}
	if loadedSettings.TerminalColorMode != "light" {
		t.Fatalf("terminal color mode setting was not persisted: %+v", loadedSettings)
	}
	if !loadedSettings.OlderMacMode {
		t.Fatalf("older Mac mode setting was not persisted: %+v", loadedSettings)
	}
}

func TestDestroyWorkspaceOnlyEndsItsKeptRDPSessions(t *testing.T) {
	h := newKeptHarness(t)
	status, body := h.post("alice", "/api/users/alice/sessions", map[string]string{"name": "Keep"})
	if status != http.StatusCreated {
		t.Fatalf("create second workspace = %d %s", status, body)
	}
	var keptWorkspace store.Session
	if err := json.Unmarshal(body, &keptWorkspace); err != nil {
		t.Fatal(err)
	}
	sessions := map[rdpsession.Key]*rdpsession.Session{}
	for _, pane := range []struct{ account, workspace, id string }{
		{"alice", h.spaces["alice"], "pane-1"},
		{"alice", h.spaces["alice"], "pane-2"},
		{"alice", keptWorkspace.ID, "pane-1"},
		{"bob", h.spaces["bob"], "pane-1"},
	} {
		request := h.createBody(pane.account, pane.id)
		request["workspaceId"] = pane.workspace
		if status, body := h.post(pane.account, "/api/rdp-kept", request); status != http.StatusCreated {
			t.Fatalf("create kept session = %d %s", status, body)
		}
		key := rdpsession.Key{Owner: pane.account, Pane: pane.workspace + "/" + pane.id}
		session, ok := h.manager.Get(key)
		if !ok {
			t.Fatalf("missing kept session %v", key)
		}
		sessions[key] = session
	}
	remove := func(account, owner, workspace string) int {
		t.Helper()
		request, err := http.NewRequest(http.MethodDelete, h.server.URL+"/api/users/"+owner+"/sessions/"+workspace, nil)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Cookie", signInCookie+"="+h.cookies[account])
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		return response.StatusCode
	}
	for _, attempt := range []struct {
		account, owner, workspace string
		status                    int
	}{
		{"bob", "alice", h.spaces["alice"], http.StatusNotFound},
		{"alice", "alice", "missing", http.StatusNotFound},
		{"bob", "bob", h.spaces["bob"], http.StatusConflict},
	} {
		if status := remove(attempt.account, attempt.owner, attempt.workspace); status != attempt.status {
			t.Fatalf("rejected deletion = %d, want %d", status, attempt.status)
		}
	}
	for key, session := range sessions {
		if session.Info().State != rdpsession.StateActive {
			t.Fatalf("a rejected deletion ended session %v", key)
		}
	}
	viewer, _, err := h.view("alice", h.spaces["alice"], "pane-1")
	if err != nil {
		t.Fatal(err)
	}
	defer viewer.Close()
	if frame := readFrame(t, viewer); frame[0] != rdpsession.ViewDesktopSize {
		t.Fatalf("initial viewer frame = %v", frame)
	}
	if status := remove("alice", "alice", h.spaces["alice"]); status != http.StatusNoContent {
		t.Fatalf("delete workspace = %d, want 204", status)
	}
	if frame := readFrame(t, viewer); frame[0] != rdpsession.ViewEnded {
		t.Fatalf("deleted workspace's viewer was not ended: %v", frame)
	}
	for key, session := range sessions {
		_, found := h.manager.Get(key)
		if key.Pane == h.spaces["alice"]+"/pane-1" || key.Pane == h.spaces["alice"]+"/pane-2" {
			if found || session.Info().State != rdpsession.StateEnded {
				t.Fatalf("deleted workspace's session survived: %v", key)
			}
		} else if !found || session.Info().State != rdpsession.StateActive {
			t.Fatalf("unrelated workspace's session was ended: %v", key)
		}
	}
	if sessions := h.list("alice"); len(sessions) != 1 || sessions[0].WorkspaceID != keptWorkspace.ID {
		t.Fatalf("alice's remaining sessions = %+v", sessions)
	}
	if sessions := h.list("bob"); len(sessions) != 1 || sessions[0].WorkspaceID != h.spaces["bob"] {
		t.Fatalf("bob's remaining sessions = %+v", sessions)
	}
}
