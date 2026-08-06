package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testWebFS(appJS string) fstest.MapFS {
	return fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte(
			`<link rel="stylesheet" href="/styles.css?v=dev">` +
				`<script type="module" src="/app.js?v=dev"></script>`,
		)},
		"app.js":                 &fstest.MapFile{Data: []byte(appJS)},
		"styles.css":             &fstest.MapFile{Data: []byte(".pane {}")},
		"terminal-reconnect.mjs": &fstest.MapFile{Data: []byte("export const x = 1;")},
	}
}

func serveStatic(t *testing.T, files fstest.MapFS, target string, header http.Header) *httptest.ResponseRecorder {
	t.Helper()
	api := &API{WebFS: files}
	request := httptest.NewRequest(http.MethodGet, target, nil)
	for name, values := range header {
		request.Header[name] = values
	}
	response := httptest.NewRecorder()
	api.staticFiles()(response, request)
	return response
}

func TestIndexCarriesTheBuildHashInsteadOfThePlaceholder(t *testing.T) {
	response := serveStatic(t, testWebFS("console.log(1)"), "/", nil)
	body := response.Body.String()

	if strings.Contains(body, "?v=dev") {
		t.Fatalf("index still carries the placeholder version: %s", body)
	}
	if strings.Count(body, "?v=") != 2 {
		t.Fatalf("expected both asset URLs to be stamped: %s", body)
	}
}

// The point of deriving the version: editing any served file moves it, so
// nobody has to remember to bump a hand-written tag.
func TestTheBuildHashFollowsTheAssetsItStandsFor(t *testing.T) {
	before := serveStatic(t, testWebFS("console.log(1)"), "/", nil).Body.String()
	unchanged := serveStatic(t, testWebFS("console.log(1)"), "/", nil).Body.String()
	after := serveStatic(t, testWebFS("console.log(2)"), "/", nil).Body.String()

	if before != unchanged {
		t.Fatal("the same assets produced two different versions")
	}
	if before == after {
		t.Fatalf("an edited asset kept the old version: %s", after)
	}
}

// A module app.js imports is not named in index.html, so only a hash over
// the whole tree notices when one of them changes.
func TestTheBuildHashCoversModulesIndexNeverMentions(t *testing.T) {
	files := testWebFS("console.log(1)")
	before := serveStatic(t, files, "/", nil).Body.String()

	files["terminal-reconnect.mjs"] = &fstest.MapFile{Data: []byte("export const x = 2;")}
	after := serveStatic(t, files, "/", nil).Body.String()

	if before == after {
		t.Fatal("a changed module left the asset version untouched")
	}
}

func TestAssetsAnswerConditionalRequestsWithNotModified(t *testing.T) {
	files := testWebFS("console.log(1)")
	first := serveStatic(t, files, "/app.js", nil)
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("asset response carried no ETag to revalidate against")
	}
	if got := first.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}

	second := serveStatic(t, files, "/app.js", http.Header{"If-None-Match": []string{etag}})
	if second.Code != http.StatusNotModified {
		t.Fatalf("status = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Fatalf("304 carried a body of %d bytes", second.Body.Len())
	}
}

func TestAnEditedAssetInvalidatesTheOldValidator(t *testing.T) {
	files := testWebFS("console.log(1)")
	etag := serveStatic(t, files, "/app.js", nil).Header().Get("ETag")

	files["app.js"] = &fstest.MapFile{Data: []byte("console.log(2)")}
	response := serveStatic(t, files, "/app.js", http.Header{"If-None-Match": []string{etag}})

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 for changed content", response.Code)
	}
	if got := response.Body.String(); got != "console.log(2)" {
		t.Fatalf("body = %q, want the new content", got)
	}
}

// Files read off disk carry a real modification time, which is what lets a
// dev server invalidate an asset it did not restart for.
func TestAFileWithAModificationTimeValidatesOnIt(t *testing.T) {
	files := testWebFS("console.log(1)")
	modified := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	files["app.js"] = &fstest.MapFile{Data: []byte("console.log(1)"), ModTime: modified}
	before := serveStatic(t, files, "/app.js", nil).Header().Get("ETag")

	files["app.js"] = &fstest.MapFile{Data: []byte("console.log(1)"), ModTime: modified.Add(time.Second)}
	after := serveStatic(t, files, "/app.js", nil).Header().Get("ETag")

	if before == after {
		t.Fatalf("a touched file kept its validator: %s", after)
	}
}

// A version query is a URL fragment, and a match that ran past the closing
// quote would take the rest of the tag with it.
func TestStampingNeverReachesOutOfTheURLItMatched(t *testing.T) {
	files := testWebFS("console.log(1)")
	files["index.html"] = &fstest.MapFile{Data: []byte(
		"<!-- a comment mentioning ?v= in prose -->\n" +
			`<link rel="stylesheet" href="/styles.css?v=dev">` + "\n" +
			`<script type="module" src="/app.js?v=dev"></script>`,
	)}

	body := serveStatic(t, files, "/", nil).Body.String()

	if !strings.Contains(body, `<link rel="stylesheet" href="/styles.css?v=`) {
		t.Fatalf("stamping consumed part of the tag: %s", body)
	}
	if !strings.Contains(body, `<script type="module" src="/app.js?v=`) {
		t.Fatalf("stamping consumed part of the script tag: %s", body)
	}
	if !strings.Contains(body, "in prose -->") {
		t.Fatalf("stamping swallowed the text after a bare mention: %s", body)
	}
}

func TestUnknownPathsStillFallBackToTheStampedIndex(t *testing.T) {
	response := serveStatic(t, testWebFS("console.log(1)"), "/users/alice/sessions/session-1", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if body := response.Body.String(); strings.Contains(body, "?v=dev") {
		t.Fatalf("SPA fallback served an unstamped index: %s", body)
	}
}
