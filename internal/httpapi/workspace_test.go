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

func TestParseWorkspacePath(t *testing.T) {
	cases := []struct {
		path    string
		wantID  string
		wantSub string
		wantOK  bool
	}{
		{"/api/workspace/", "", "", true},
		{"/api/workspace/default", "default", "", true},
		{"/api/workspace/alice", "alice", "", true},
		{"/api/workspace/a%20b", "a b", "", true},
		{"/api/workspace/alice/background", "alice", "background", true},
		{"/api/workspace//background", "", "background", true},
		{"/api/workspace/alice/background/extra", "", "", false},
		{"/api/workspace/a%2Fb", "", "", false},
		{"/api/workspace/a%5Cb", "", "", false},
	}
	for _, tc := range cases {
		gotID, gotSub, gotOK := parseWorkspacePath(tc.path)
		if gotID != tc.wantID || gotSub != tc.wantSub || gotOK != tc.wantOK {
			t.Errorf("parseWorkspacePath(%q) = (%q, %q, %v), want (%q, %q, %v)",
				tc.path, gotID, gotSub, gotOK, tc.wantID, tc.wantSub, tc.wantOK)
		}
	}
}

func TestUserAllowed(t *testing.T) {
	single := &API{}
	if !single.userAllowed("default") {
		t.Error("single-user mode should allow the default workspace")
	}
	if !single.userAllowed("") {
		t.Error("single-user mode should allow the empty (default) id")
	}
	if single.userAllowed("alice") {
		t.Error("single-user mode should reject non-default workspaces")
	}

	multi := &API{Users: []string{"alice", "bob"}}
	if !multi.userAllowed("alice") || !multi.userAllowed("bob") {
		t.Error("multi-user mode should allow rostered users")
	}
	if multi.userAllowed("default") {
		t.Error("multi-user mode should not allow the default workspace")
	}
	if multi.userAllowed("carol") {
		t.Error("multi-user mode should reject users outside the roster")
	}
}

func TestWorkspaceDocumentRejectsStaleRevision(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "tessera.sqlite3"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	first, err := st.LoadDefaultWorkspace(ctx, "")
	if err != nil {
		t.Fatalf("load first workspace copy: %v", err)
	}
	stale, err := st.LoadWorkspace(ctx, store.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("load stale workspace copy: %v", err)
	}
	api := &API{Store: st}

	putWorkspace := func(ws *store.Workspace) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(ws)
		if err != nil {
			t.Fatalf("marshal workspace: %v", err)
		}
		request := httptest.NewRequest(http.MethodPut, "/api/workspace/default", bytes.NewReader(body))
		response := httptest.NewRecorder()
		api.workspaceDocument(response, request, store.DefaultWorkspaceID)
		return response
	}

	first.Panes = []store.Pane{{ID: "pane-new", Title: "New state", Width: 320, Height: 200}}
	first.Layout = json.RawMessage(`{"panes":["pane-new"]}`)
	winner := putWorkspace(first)
	if winner.Code != http.StatusOK {
		t.Fatalf("winning save status = %d, want %d: %s", winner.Code, http.StatusOK, winner.Body.String())
	}
	var result struct {
		Revision string `json:"revision"`
	}
	if err := json.NewDecoder(winner.Body).Decode(&result); err != nil {
		t.Fatalf("decode winning response: %v", err)
	}
	if result.Revision == "" || result.Revision == stale.Revision {
		t.Fatalf("winning revision = %q, want a new non-empty revision", result.Revision)
	}

	stale.Panes = []store.Pane{{ID: "pane-stale", Title: "Stale state", Width: 320, Height: 200}}
	stale.Layout = json.RawMessage(`{"panes":["pane-stale"]}`)
	conflict := putWorkspace(stale)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("stale save status = %d, want %d: %s", conflict.Code, http.StatusConflict, conflict.Body.String())
	}

	loaded, err := st.LoadWorkspace(ctx, store.DefaultWorkspaceID)
	if err != nil {
		t.Fatalf("reload workspace: %v", err)
	}
	if len(loaded.Panes) != 1 || loaded.Panes[0].ID != "pane-new" || loaded.Revision != result.Revision {
		t.Fatalf("stale request changed winning workspace: %+v", loaded)
	}
}
