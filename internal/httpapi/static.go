package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func (a *API) staticFiles() http.HandlerFunc {
	webDir := a.WebDir
	if webDir == "" {
		webDir = "web"
	}
	fileServer := http.FileServer(http.Dir(webDir))

	return func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "not found")
			return
		}

		requestPath := strings.TrimPrefix(filepath.Clean(r.URL.Path), string(filepath.Separator))
		if requestPath == "." || requestPath == "" {
			http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
			return
		}

		fullPath := filepath.Join(webDir, requestPath)
		info, err := os.Stat(fullPath)
		if err != nil || info.IsDir() {
			http.ServeFile(w, r, filepath.Join(webDir, "index.html"))
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
