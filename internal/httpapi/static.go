package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

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
			http.ServeFileFS(w, r, webFS, "index.html")
			return
		}

		info, err := fs.Stat(webFS, requestPath)
		if err != nil || info.IsDir() {
			http.ServeFileFS(w, r, webFS, "index.html")
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
