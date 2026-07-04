package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"tessera/internal/shell"
	"tessera/internal/store"
)

type runCommandRequest struct {
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
	Command     string `json:"command"`
	Cwd         string `json:"cwd"`
}

func (a *API) runCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}

	var req runCommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid run JSON")
		return
	}
	req.Command = strings.TrimRight(req.Command, "\r\n")
	if strings.TrimSpace(req.Command) == "" {
		writeError(w, http.StatusBadRequest, "command is required")
		return
	}
	if req.WorkspaceID == "" {
		req.WorkspaceID = store.DefaultWorkspaceID
	}
	if req.PaneID == "" {
		writeError(w, http.StatusBadRequest, "paneId is required")
		return
	}

	runID := store.NewID("run")
	if err := a.Store.StartCommandRun(r.Context(), runID, req.WorkspaceID, req.PaneID, req.Command, req.Cwd); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	encoder := json.NewEncoder(w)
	for event := range a.Runner.Run(r.Context(), shell.RunRequest{
		RunID:   runID,
		Command: req.Command,
		Cwd:     req.Cwd,
	}) {
		if err := encoder.Encode(event); err != nil {
			return
		}
		flusher.Flush()
		if event.Type == "exit" && event.Code != nil {
			_ = a.Store.FinishCommandRun(r.Context(), runID, event.Cwd, *event.Code)
		}
	}
}
