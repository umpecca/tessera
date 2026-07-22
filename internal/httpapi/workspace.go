package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"tessera/internal/store"
)

// workspace routes /api/workspace/{id} and its /background sub-resource. An
// empty id (i.e. the bare /api/workspace/ path) maps to the legacy default
// workspace. Named-session ids are opaque and authorized through their owner.
func (a *API) workspace(w http.ResponseWriter, r *http.Request) {
	id, sub, ok := parseWorkspacePath(r.URL.Path)
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid workspace id")
		return
	}
	if id == "" {
		id = store.DefaultWorkspaceID
	}
	if !a.workspaceAllowed(r.Context(), id) {
		writeError(w, http.StatusNotFound, "unknown workspace")
		return
	}

	switch sub {
	case "":
		a.workspaceDocument(w, r, id)
	case "background":
		a.workspaceBackground(w, r, id)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

// workspaceDocument serves GET/PUT for the workspace layout and panes.
func (a *API) workspaceDocument(w http.ResponseWriter, r *http.Request, id string) {
	switch r.Method {
	case http.MethodGet:
		ws, err := a.Store.LoadOrCreateWorkspace(r.Context(), id, id)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, ws)
	case http.MethodPut:
		var ws store.Workspace
		if err := json.NewDecoder(r.Body).Decode(&ws); err != nil {
			writeError(w, http.StatusBadRequest, "invalid workspace JSON")
			return
		}
		// The path is authoritative for the id so a client cannot save into a
		// different workspace than the one it addressed.
		ws.ID = id
		if a.Runs != nil {
			activePaneIDs := a.Runs.ActivePaneIDs(ws.ID)
			if err := a.Store.PreservePaneBuffers(r.Context(), &ws, activePaneIDs); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		if err := a.Store.SaveWorkspace(r.Context(), &ws); errors.Is(err, store.ErrWorkspaceConflict) {
			writeError(w, http.StatusConflict, err.Error())
			return
		} else if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "saved", "revision": ws.Revision})
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

// parseWorkspacePath splits a /api/workspace/{id} or /api/workspace/{id}/{sub}
// path into its id and optional single sub-resource segment. It rejects ids or
// sub-resources containing further path separators so each stays a single,
// opaque token.
func parseWorkspacePath(path string) (id, sub string, ok bool) {
	rest := strings.TrimPrefix(path, "/api/workspace/")
	first, remainder, hasSub := strings.Cut(rest, "/")

	id, err := url.PathUnescape(first)
	if err != nil || strings.ContainsAny(id, "/\\") {
		return "", "", false
	}
	if !hasSub {
		return id, "", true
	}

	sub, err = url.PathUnescape(remainder)
	if err != nil || strings.ContainsAny(sub, "/\\") {
		return "", "", false
	}
	return id, sub, true
}
