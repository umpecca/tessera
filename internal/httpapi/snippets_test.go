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

func TestSnippetsAPIConflictIsolationAndValidation(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(ctx, filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	api := &API{Store: st, Users: []string{"alice", "bob"}}
	mux := http.NewServeMux()
	api.Register(mux)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(method, path, bytes.NewBufferString(body)))
		return w
	}
	decode := func(w *httptest.ResponseRecorder) store.Snippets {
		t.Helper()
		var doc store.Snippets
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body)
		}
		if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		return doc
	}
	loaded := decode(request("GET", "/api/users/alice/snippets", ""))
	if len(loaded.Snippets) != 0 || loaded.Revision == "" {
		t.Fatalf("fresh = %+v", loaded)
	}
	body, _ := json.Marshal(store.Snippets{Revision: loaded.Revision, Snippets: []store.Snippet{{ID: "a", Label: "Tests", Text: "npm test"}}})
	saved := decode(request("PUT", "/api/users/alice/snippets", string(body)))
	if saved.Revision == loaded.Revision || len(saved.Snippets) != 1 {
		t.Fatalf("saved = %+v", saved)
	}
	if w := request("PUT", "/api/users/alice/snippets", string(body)); w.Code != http.StatusConflict {
		t.Fatalf("stale save: %d %s", w.Code, w.Body)
	}
	if bob := decode(request("GET", "/api/users/bob/snippets", "")); len(bob.Snippets) != 0 {
		t.Fatalf("bob = %+v", bob)
	}
	for _, bad := range []string{
		`{"revision":"` + saved.Revision + `","snippets":[{"id":"a","text":""}]}`,
		`{"revision":"` + saved.Revision + `","snippets":[],"extra":1}`,
		`{"revision":"` + saved.Revision + `","snippets":[]} {}`,
	} {
		if w := request("PUT", "/api/users/alice/snippets", bad); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", bad, w.Code)
		}
	}
	for _, path := range []string{"/api/users/mallory/snippets", "/api/users/alice/snippets/a"} {
		if w := request("GET", path, ""); w.Code != http.StatusNotFound {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
	if w := request("DELETE", "/api/users/alice/snippets", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("DELETE: %d", w.Code)
	}
}
