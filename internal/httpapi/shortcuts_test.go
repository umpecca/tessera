package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"tessera/internal/shortcuts"
	"tessera/internal/store"
)

func TestShortcutsAPIValidationIsolationAndLaunch(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	alice, err := st.EnsureUserDefaultSession(ctx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := st.EnsureUserDefaultSession(ctx, "bob")
	if err != nil {
		t.Fatal(err)
	}
	api := &API{Store: st, Users: []string{"alice", "bob"}}
	mux := http.NewServeMux()
	api.Register(mux)
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		var b bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&b).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, &b))
		return w
	}
	response := request("GET", "/api/users/alice/shortcuts", nil)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	var doc store.Shortcuts
	if err := json.Unmarshal(response.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	oldRevision := doc.Revision
	doc.Shortcuts = []shortcuts.Shortcut{{ID: "editor", Name: "Editor", Code: "CE", Command: "echo", Fields: []shortcuts.Field{{ID: "file", Label: "File", Type: "text"}}}}
	response = request("PUT", "/api/users/alice/shortcuts", doc)
	if response.Code != 200 {
		t.Fatal(response.Body.String())
	}
	json.Unmarshal(response.Body.Bytes(), &doc)
	stale := doc
	stale.Revision = oldRevision
	if response := request("PUT", "/api/users/alice/shortcuts", stale); response.Code != 409 {
		t.Fatal("stale save", response.Code)
	}
	for _, code := range []string{"NN", "CS", "SA"} {
		bad := doc
		bad.Shortcuts = append([]shortcuts.Shortcut{}, doc.Shortcuts...)
		bad.Shortcuts[0].Code = code
		if response := request("PUT", "/api/users/alice/shortcuts", bad); response.Code != 400 {
			t.Fatal("code accepted", code, response.Code)
		}
	}
	response = request("GET", "/api/users/bob/shortcuts", nil)
	var isolated store.Shortcuts
	json.Unmarshal(response.Body.Bytes(), &isolated)
	if len(isolated.Shortcuts) != 0 {
		t.Fatal("user data leaked")
	}
	if response := request("GET", "/api/users/stranger/shortcuts", nil); response.Code != 404 {
		t.Fatal("unknown user accepted")
	}
	values := map[string]any{"workspaceId": alice.ID, "cwd": t.TempDir(), "values": map[string]any{"file": "file with spaces ' 世界.txt"}}
	response = request("POST", "/api/users/alice/shortcuts/editor/launch", values)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "Editor") {
		t.Fatal(response.Code, response.Body.String())
	}
	values["workspaceId"] = bob.ID
	if response := request("POST", "/api/users/alice/shortcuts/editor/launch", values); response.Code != 404 {
		t.Fatal("cross-owner workspace accepted", response.Code)
	}
	values["workspaceId"] = alice.ID
	values["shortcut"] = doc.Shortcuts[0]
	if response := request("POST", "/api/users/alice/shortcuts/editor/launch", values); response.Code != 400 {
		t.Fatal("saved command override accepted")
	}
	if response := request("POST", "/api/users/alice/shortcuts/test", values); response.Code != 200 {
		t.Fatal("draft test failed", response.Body.String())
	}
	delete(values, "shortcut")
	values["cwd"] = "relative"
	if response := request("POST", "/api/users/alice/shortcuts/editor/launch", values); response.Code != 400 {
		t.Fatal("relative cwd accepted")
	}
	if response := request("POST", "/api/users/alice/shortcuts/missing/launch", values); response.Code != 404 {
		t.Fatal("missing launch accepted")
	}
	for _, body := range []string{`{"revision":"` + doc.Revision + `","shortcuts":[],"unknown":true}`, `{} {}`, strings.Repeat(" ", 256*1024) + `{}`} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("PUT", "/api/users/alice/shortcuts", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatal("malformed request accepted", w.Code)
		}
	}
}
