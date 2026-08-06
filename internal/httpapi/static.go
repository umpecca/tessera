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

		info, err := fs.Stat(webFS, requestPath)
		if err != nil || info.IsDir() {
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
