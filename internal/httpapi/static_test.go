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

func TestExtensionDownloadContentTypesAndMissingPackage(t *testing.T) {
	files := testWebFS("test")
	for _, item := range []struct{ name, contentType string }{
		{"extensions/tessera-clipboard.xpi", "application/x-xpinstall"},
		{"extensions/tessera-clipboard-dev.zip", "application/zip"},
		{"extensions/firefox-clipboard.json", "application/json"},
	} {
		files[item.name] = &fstest.MapFile{Data: []byte("package bytes")}
		response := serveStatic(t, files, "/"+item.name, nil)
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != item.contentType || response.Body.String() != "package bytes" {
			t.Fatalf("incorrect extension response for %s: %d %v", item.name, response.Code, response.Header())
		}
	}
	response := serveStatic(t, files, "/extensions/missing.xpi", nil)
	if response.Code != http.StatusNotFound {
		t.Fatalf("missing XPI served SPA: %d", response.Code)
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

func servedBuildHash(t *testing.T, files fstest.MapFS) string {
	t.Helper()
	body := serveStatic(t, files, "/", nil).Body.String()
	start := strings.Index(body, "/app.js?v=")
	if start < 0 {
		t.Fatalf("index carries no app.js version: %s", body)
	}
	hash := body[start+len("/app.js?v="):]
	return hash[:strings.IndexByte(hash, '"')]
}

// app.js is loaded at the build hash, so the modules it imports must be too,
// or each page load would revalidate them; and each module must be reached
// at one URL, or the browser would run it twice.
func TestModuleImportsCarryTheBuildHash(t *testing.T) {
	files := testWebFS(`import { x } from "./terminal-reconnect.mjs";
export { y } from './pane.mjs';
const later = import("./vendor/vnc.js?v=novnc-1.7.0");
const mixed = import("./odd.mjs');
const absolute = import("https://example.com/x.js");`)
	files["vendor/terminal.js"] = &fstest.MapFile{Data: []byte(`import("./chunk.js")`)}
	hash := servedBuildHash(t, files)

	body := serveStatic(t, files, "/app.js?v="+hash, nil).Body.String()
	for _, want := range []string{
		`from "./terminal-reconnect.mjs?v=` + hash + `"`,
		`from './pane.mjs?v=` + hash + `'`,
		`import("./vendor/vnc.js?v=` + hash + `")`,
		`import("./odd.mjs')`,
		`import("https://example.com/x.js")`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("served app.js lacks %s:\n%s", want, body)
		}
	}
	if got := serveStatic(t, files, "/vendor/terminal.js", nil).Body.String(); got != `import("./chunk.js")` {
		t.Errorf("vendor bundle was rewritten: %s", got)
	}
}

func TestOnlyTheCurrentBuildHashIsCachedForGood(t *testing.T) {
	files := testWebFS(`import { x } from "./terminal-reconnect.mjs";`)
	hash := servedBuildHash(t, files)

	for target, want := range map[string]string{
		"/":                                 "no-cache",
		"/app.js?v=" + hash:                 immutableCacheControl,
		"/terminal-reconnect.mjs?v=" + hash: immutableCacheControl,
		"/styles.css?v=" + hash:             immutableCacheControl,
		"/app.js":                           "no-cache",
		"/app.js?v=stale":                   "no-cache",
		"/missing.js?v=" + hash:             "no-cache",
	} {
		if got := serveStatic(t, files, target, nil).Header().Get("Cache-Control"); got != want {
			t.Errorf("%s: Cache-Control = %q, want %q", target, got, want)
		}
	}
}

// A dev WebDir can change under a running server, so it is never cached for
// good and its sources are served exactly as written.
func TestAssetsOnDiskAreNeitherRewrittenNorCachedForGood(t *testing.T) {
	files := testWebFS(`import { x } from "./terminal-reconnect.mjs";`)
	files["app.js"].ModTime = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	hash := servedBuildHash(t, files)

	response := serveStatic(t, files, "/app.js?v="+hash, nil)
	if got := response.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("Cache-Control = %q, want no-cache", got)
	}
	if body := response.Body.String(); body != `import { x } from "./terminal-reconnect.mjs";` {
		t.Errorf("disk asset was rewritten: %s", body)
	}
}
