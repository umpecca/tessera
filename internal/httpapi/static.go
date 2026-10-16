package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"
)

// staticContentTypes pins the Content-Type for the asset kinds we serve.
// Go's mime package otherwise consults the OS (the Windows registry in
// particular), which can mislabel .js or .css and break module loading; and it
// has no built-in type for .webmanifest. Setting the header explicitly before
// serving keeps behavior identical across machines.
var staticContentTypes = map[string]string{
	".xpi":         "application/x-xpinstall",
	".zip":         "application/zip",
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".wasm":        "application/wasm",
	".woff2":       "font/woff2",
	".woff":        "font/woff",
	".ttf":         "font/ttf",
}

// assetVersionPattern matches the cache-busting query on the asset URLs in
// index.html. The value in the file is a placeholder; the build hash is
// substituted on the way out, so nobody has to remember to bump it. The
// character class stops at anything that cannot appear inside a URL in an
// attribute, so a match can never run past the end of the tag it is in.
var assetVersionPattern = regexp.MustCompile(`\?v=[^"'\s<>]*`)

// moduleImportPattern matches a relative specifier in a static import or
// export, or in a dynamic import of a string literal, along with any version
// query already on it. Group 2 and 4 are the quotes, which must agree.
var moduleImportPattern = regexp.MustCompile(`(\b(?:from|import)\s*\(?\s*)(["'])(\.{1,2}/[^"'?#\s]+\.m?js)(?:\?v=[^"'\s]*)?(["'])`)

// immutableCacheControl is sent for an asset requested at the current build
// hash. Its URL changes whenever any served file does, so the browser can keep
// it without asking again; index.html, which names the hash, stays no-cache.
const immutableCacheControl = "public, max-age=31536000, immutable"

func (a *API) staticFiles() http.HandlerFunc {
	webFS := a.WebFS
	if webFS == nil {
		// An API assembled without web assets still answers /api; it just
		// has no page to serve.
		return func(w http.ResponseWriter, r *http.Request) {
			writeError(w, http.StatusNotFound, "not found")
		}
	}
	fileServer := http.FileServer(http.FS(webFS))
	buildHash := webBuildHash(webFS)
	// Embedded assets cannot change while the server runs, so their module
	// graph can be versioned once and cached for good. Files served from disk
	// (a dev WebDir) can be edited underneath us and keep revalidating.
	var modules map[string][]byte
	if embeddedAssets(webFS) {
		modules = versionModuleImports(webFS, buildHash)
	}

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		w.Header().Set("Cache-Control", "no-cache")

		requestPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requestPath == "" || requestPath == "." {
			serveIndex(w, r, webFS, buildHash)
			return
		}
		if modules != nil && r.URL.Query().Get("v") == buildHash {
			w.Header().Set("Cache-Control", immutableCacheControl)
		}
		if module, ok := modules[requestPath]; ok {
			setContentType(w, requestPath)
			w.Header().Set("ETag", `"`+buildHash+`"`)
			http.ServeContent(w, r, requestPath, time.Time{}, bytes.NewReader(module))
			return
		}

		info, err := fs.Stat(webFS, requestPath)
		if err != nil || info.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			if strings.HasPrefix(requestPath, "extensions/") {
				writeError(w, http.StatusNotFound, "extension asset not found")
				return
			}
			serveIndex(w, r, webFS, buildHash)
			return
		}
		setContentType(w, requestPath)
		// no-cache means the browser asks before reusing what it has. Without
		// a validator to answer with, every ask is a full download; with one,
		// an unchanged asset costs a 304.
		w.Header().Set("ETag", assetETag(info, buildHash))
		fileServer.ServeHTTP(w, r)
	}
}

// serveIndex hands back index.html with the asset version stamped in. The
// page is what points at app.js and styles.css, so a build hash carried
// there is what moves a browser off a stale copy of either.
func serveIndex(w http.ResponseWriter, r *http.Request, webFS fs.FS, buildHash string) {
	setContentType(w, "index.html")
	page, err := fs.ReadFile(webFS, "index.html")
	if err != nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	page = assetVersionPattern.ReplaceAll(page, []byte("?v="+buildHash))
	w.Header().Set("ETag", `"`+hashBytes(page)+`"`)
	http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(page))
}

// assetETag identifies the bytes a request would receive. Files read off
// disk carry a modification time that moves when they are edited, which is
// what a dev server needs; embedded files have none, so they fall back to
// the hash of the build they came from.
func assetETag(info fs.FileInfo, buildHash string) string {
	if modified := info.ModTime(); !modified.IsZero() {
		return fmt.Sprintf(`"%x-%x"`, modified.UnixNano(), info.Size())
	}
	return `"` + buildHash + `"`
}

// webBuildHash digests every served file into one identifier for this build
// of the web assets. Hashing the whole tree, rather than the two files named
// in index.html, means a change to any module they import moves it too.
func webBuildHash(webFS fs.FS) string {
	digest := sha256.New()
	err := fs.WalkDir(webFS, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		file, err := webFS.Open(name)
		if err != nil {
			return err
		}
		defer file.Close()
		fmt.Fprintf(digest, "%s\x00", name)
		_, err = io.Copy(digest, file)
		return err
	})
	if err != nil {
		// An unreadable tree is not a reason to refuse to serve; a version
		// that changes every start is only as bad as no caching at all.
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(digest.Sum(nil))[:12]
}

// embeddedAssets reports whether webFS is the build's embedded tree, whose
// files carry no modification time, rather than a directory on disk. Any
// file with one could be edited while the server runs.
func embeddedAssets(webFS fs.FS) bool {
	embedded := true
	err := fs.WalkDir(webFS, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !entry.IsDir() && !info.ModTime().IsZero() {
			embedded = false
			return fs.SkipAll
		}
		return nil
	})
	return err == nil && embedded
}

// versionModuleImports stamps the build hash onto every relative module
// import in Tessera's own scripts. index.html already loads app.js at the
// hash; without this, the modules app.js imports would be fetched at bare
// URLs, which can never be cached immutably, and every page load would
// revalidate each one in dependent waves. Every module must be reached at a
// single URL, or the browser would instantiate it twice. Vendor bundles are
// esbuild output with no relative imports and are left byte-for-byte alone.
func versionModuleImports(webFS fs.FS, buildHash string) map[string][]byte {
	modules := map[string][]byte{}
	_ = fs.WalkDir(webFS, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasPrefix(name, "vendor/") || strings.HasPrefix(name, "extensions/") {
			return nil
		}
		if ext := path.Ext(name); ext != ".js" && ext != ".mjs" {
			return nil
		}
		source, err := fs.ReadFile(webFS, name)
		if err != nil {
			return nil
		}
		modules[name] = moduleImportPattern.ReplaceAllFunc(source, func(match []byte) []byte {
			parts := moduleImportPattern.FindSubmatch(match)
			if !bytes.Equal(parts[2], parts[4]) {
				return match
			}
			return []byte(string(parts[1]) + string(parts[2]) + string(parts[3]) + "?v=" + buildHash + string(parts[4]))
		})
		return nil
	})
	return modules
}

func hashBytes(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])[:12]
}

// setContentType pins the response Content-Type for known extensions. http's
// file serving only sets the type when the header is absent, so this wins.
func setContentType(w http.ResponseWriter, name string) {
	ext := strings.ToLower(path.Ext(name))
	if ctype, ok := staticContentTypes[ext]; ok {
		w.Header().Set("Content-Type", ctype)
	}
}
