package httpapi

import (
	"encoding/json"
	"io/fs"
	"net/http"

	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
)

type API struct {
	Store     *store.Store
	Runner    *shell.Runner
	Runs      *runs.Manager
	Terminals *terminal.Manager
	WebFS     fs.FS
}

func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", a.health)
	mux.HandleFunc("/api/workspace/default", a.defaultWorkspace)
	mux.HandleFunc("/api/run", a.runCommand)
	mux.HandleFunc("/api/runs", a.listRuns)
	mux.HandleFunc("/api/runs/", a.runEvents)
	mux.HandleFunc("/api/terminal", a.terminalSession)
	mux.HandleFunc("/api/directories", a.listDirectories)
	mux.HandleFunc("/", a.staticFiles())
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeError(w, http.StatusMethodNotAllowed, "method not allowed")
}
