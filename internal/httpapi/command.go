package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"tessera/internal/runs"
	"tessera/internal/store"
)

type runCommandRequest struct {
	WorkspaceID  string `json:"workspaceId"`
	PaneID       string `json:"paneId"`
	Command      string `json:"command"`
	Cwd          string `json:"cwd"`
	InsertPos    int    `json:"insertPos"`
	OutputPrefix string `json:"outputPrefix"`
}

func (a *API) runCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if a.Runs == nil {
		writeError(w, http.StatusInternalServerError, "run manager is not available")
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
	if !a.workspaceAllowed(r.Context(), req.WorkspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}

	events, unsubscribe, _, err := a.Runs.Start(runs.StartRequest{
		WorkspaceID:  req.WorkspaceID,
		PaneID:       req.PaneID,
		Command:      req.Command,
		Cwd:          req.Cwd,
		InsertPos:    req.InsertPos,
		OutputPrefix: req.OutputPrefix,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	defer unsubscribe()

	streamRunEvents(w, r, events)
}

func (a *API) listRuns(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if a.Runs == nil {
		writeError(w, http.StatusInternalServerError, "run manager is not available")
		return
	}
	workspaceID := r.URL.Query().Get("workspaceId")
	if workspaceID == "" {
		workspaceID = store.DefaultWorkspaceID
	}
	if !a.workspaceAllowed(r.Context(), workspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": a.Runs.ActiveRuns(workspaceID)})
}

func (a *API) runEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	if a.Runs == nil {
		writeError(w, http.StatusInternalServerError, "run manager is not available")
		return
	}
	runID := strings.TrimPrefix(r.URL.Path, "/api/runs/")
	runID = strings.TrimSuffix(runID, "/events")
	runID = strings.Trim(runID, "/")
	if runID == "" {
		writeError(w, http.StatusBadRequest, "run id is required")
		return
	}
	events, unsubscribe, ok := a.Runs.Subscribe(runID, true)
	if !ok {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	defer unsubscribe()

	streamRunEvents(w, r, events)
}

func streamRunEvents(w http.ResponseWriter, r *http.Request, events <-chan runs.Event) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming is not supported")
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	encoder := json.NewEncoder(w)
	for {
		select {
		case <-r.Context().Done():
			return
		case event, ok := <-events:
			if !ok {
				return
			}
			if err := encoder.Encode(event); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
