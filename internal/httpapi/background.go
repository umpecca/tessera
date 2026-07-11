package httpapi

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strings"
)

// maxBackgroundBytes caps a stored background image. Images are held in SQLite
// and served on demand, so this keeps a single upload from bloating the DB.
const maxBackgroundBytes = 10 << 20 // 10 MiB

// workspaceBackground serves GET/PUT/DELETE for a workspace's background image.
// The caller has already validated that id is an allowed workspace.
func (a *API) workspaceBackground(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		bg, err := a.Store.LoadWorkspaceBackground(r.Context(), id)
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, http.StatusNotFound, "no background image")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.Header().Set("Content-Type", bg.MimeType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-cache")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(bg.Image)

	case http.MethodPut:
		mime, ok := imageMimeType(r.Header.Get("Content-Type"))
		if !ok {
			writeError(w, http.StatusUnsupportedMediaType, "background must be an image")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBackgroundBytes)
		data, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "image is too large (max 10MB)")
			return
		}
		if len(data) == 0 {
			writeError(w, http.StatusBadRequest, "image is empty")
			return
		}
		// Prefer the sniffed type for raster images; it is more trustworthy than
		// a client-declared header and normalizes odd values.
		if sniffed := http.DetectContentType(data); strings.HasPrefix(sniffed, "image/") {
			mime = sniffed
		}
		// Ensure the workspace row exists so the background's foreign key holds
		// even if the client uploads before its first workspace save.
		if _, err := a.Store.LoadOrCreateWorkspace(r.Context(), id, id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		version, err := a.Store.SaveWorkspaceBackground(r.Context(), id, mime, data)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "saved", "version": version})

	case http.MethodDelete:
		if err := a.Store.DeleteWorkspaceBackground(r.Context(), id); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// imageMimeType strips any parameters from a Content-Type header and reports
// whether the base type is an image.
func imageMimeType(header string) (string, bool) {
	mime := header
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = mime[:i]
	}
	mime = strings.TrimSpace(mime)
	if !strings.HasPrefix(mime, "image/") {
		return "", false
	}
	return mime, true
}
