package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type fileWriteRequest struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

func (a *API) fileContents(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		path := cleanFilePath(r.URL.Query().Get("path"))
		if path == "" {
			writeError(w, http.StatusBadRequest, "path is required")
			return
		}
		info, err := os.Stat(path)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		if info.IsDir() {
			writeError(w, http.StatusBadRequest, "path is a directory")
			return
		}
		content, err := os.ReadFile(path)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{
			"path": path,
			"text": string(content),
		})
	case http.MethodPut:
		var req fileWriteRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid file JSON")
			return
		}
		path := cleanFilePath(req.Path)
		if path == "" {
			writeError(w, http.StatusBadRequest, "path is required")
			return
		}
		if info, err := os.Stat(path); err == nil && info.IsDir() {
			writeError(w, http.StatusBadRequest, "path is a directory")
			return
		}
		if info, err := os.Stat(filepath.Dir(path)); err != nil || !info.IsDir() {
			if err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
			} else {
				writeError(w, http.StatusBadRequest, "parent path is not a directory")
			}
			return
		}
		if err := os.WriteFile(path, []byte(req.Text), 0o644); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"path": path, "status": "saved"})
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

func cleanFilePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return filepath.Clean(path)
}
