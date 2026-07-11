package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
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

func (a *API) staticFiles() http.HandlerFunc {
	webFS := a.WebFS
	fileServer := http.FileServer(http.FS(webFS))

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		w.Header().Set("Cache-Control", "no-cache")

		requestPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requestPath == "" || requestPath == "." {
			setContentType(w, "index.html")
			http.ServeFileFS(w, r, webFS, "index.html")
			return
		}

		info, err := fs.Stat(webFS, requestPath)
		if err != nil || info.IsDir() {
			setContentType(w, "index.html")
			http.ServeFileFS(w, r, webFS, "index.html")
			return
		}
		setContentType(w, requestPath)
		fileServer.ServeHTTP(w, r)
	}
}

// setContentType pins the response Content-Type for known extensions. http's
// file serving only sets the type when the header is absent, so this wins.
func setContentType(w http.ResponseWriter, name string) {
	ext := strings.ToLower(path.Ext(name))
	if ctype, ok := staticContentTypes[ext]; ok {
		w.Header().Set("Content-Type", ctype)
	}
}
