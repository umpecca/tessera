package httpapi

import (
	"encoding/json"
	"net/http"
	"os"

	"tessera/internal/store"
)

func (a *API) defaultWorkspace(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		defaultCwd, _ := os.Getwd()
		ws, err := a.Store.LoadDefaultWorkspace(r.Context(), defaultCwd)
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
		ws.ID = store.DefaultWorkspaceID
		if a.Runs != nil {
			activePaneIDs := a.Runs.ActivePaneIDs(ws.ID)
			if err := a.Store.PreservePaneBuffers(r.Context(), &ws, activePaneIDs); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
		if err := a.Store.SaveWorkspace(r.Context(), &ws); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "saved"})
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}
