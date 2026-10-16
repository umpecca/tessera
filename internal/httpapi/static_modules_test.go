package httpapi

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path"
	"regexp"
	"strings"
	"testing"

	"tessera/web"
)

// Any relative specifier in an import, however it is written. Broader than
// moduleImportPattern on purpose: a form the rewrite misses would load that
// module at a second, unversioned URL and run it twice.
var anyRelativeImport = regexp.MustCompile(`\b(?:from|import)\s*\(?\s*["'](\.{1,2}/[^"']*)["']`)

func TestEveryShippedModuleImportIsVersionedAndResolves(t *testing.T) {
	api := &API{WebFS: web.Files}
	handler := api.staticFiles()
	index := httptest.NewRecorder()
	handler(index, httptest.NewRequest(http.MethodGet, "/", nil))
	match := regexp.MustCompile(`/app\.js\?v=([0-9a-f]+)`).FindStringSubmatch(index.Body.String())
	if match == nil {
		t.Fatal("index does not load app.js at a build hash")
	}
	hash := match[1]

	checked := 0
	err := fs.WalkDir(web.Files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasPrefix(name, "vendor/") || strings.HasPrefix(name, "extensions/") {
			return err
		}
		if ext := path.Ext(name); ext != ".js" && ext != ".mjs" {
			return nil
		}
		response := httptest.NewRecorder()
		handler(response, httptest.NewRequest(http.MethodGet, "/"+name+"?v="+hash, nil))
		for _, found := range anyRelativeImport.FindAllStringSubmatch(response.Body.String(), -1) {
			specifier, version, _ := strings.Cut(found[1], "?")
			if version != "v="+hash {
				t.Errorf("%s imports %q without the build hash", name, found[1])
			}
			if _, err := fs.Stat(web.Files, path.Join(path.Dir(name), specifier)); err != nil {
				t.Errorf("%s imports %q, which is not shipped", name, specifier)
			}
			checked++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if checked < 20 {
		t.Fatalf("checked only %d imports; the shipped module graph was not found", checked)
	}
}
