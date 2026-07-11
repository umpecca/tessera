package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
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
	// Users is the roster for multi-user mode. When empty, Tessera runs in
	// single-user mode with just the default workspace.
	Users []string
}

func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", a.health)
	mux.HandleFunc("/api/users", a.users)
	mux.HandleFunc("/api/users/", a.userResources)
	mux.HandleFunc("/api/workspace/", a.workspace)
	mux.HandleFunc("/api/run", a.runCommand)
	mux.HandleFunc("/api/runs", a.listRuns)
	mux.HandleFunc("/api/runs/", a.runEvents)
	mux.HandleFunc("/api/terminal", a.terminalSession)
	mux.HandleFunc("/api/directories", a.listDirectories)
	mux.HandleFunc("/api/file", a.fileContents)
	mux.HandleFunc("/api/files", a.fileOperations)
	mux.HandleFunc("/", a.staticFiles())
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// users reports whether multi-user mode is enabled and, if so, the roster the
// selection screen should offer.
func (a *API) users(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	roster := a.Users
	if roster == nil {
		roster = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled": len(roster) > 0,
		"users":   roster,
	})
}

// userAllowed reports whether a session owner is part of this local server's
// configured roster. Single-user mode uses the synthetic "default" owner.
func (a *API) userAllowed(id string) bool {
	if len(a.Users) == 0 {
		return id == "" || id == store.DefaultWorkspaceID
	}
	for _, user := range a.Users {
		if user == id {
			return true
		}
	}
	return false
}

func (a *API) workspaceAllowed(ctx context.Context, id string) bool {
	if id == "" {
		id = store.DefaultWorkspaceID
	}
	ownerID, err := a.Store.SessionOwner(ctx, id)
	if err == nil {
		return a.userAllowed(ownerID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false
	}
	// The first workspace historically used its user id as its workspace id.
	// Allow that one missing row so first-load creation remains compatible.
	return a.userAllowed(id)
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
