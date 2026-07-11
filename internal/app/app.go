package app

import (
	"io/fs"
	"net/http"

	"tessera/internal/httpapi"
	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/web"
)

type App struct {
	Store     *store.Store
	Runner    *shell.Runner
	Runs      *runs.Manager
	Terminals *terminal.Manager
	WebFS     fs.FS
	// Users is the optional multi-user roster, passed through to the API.
	Users []string
}

func (a *App) Handler() http.Handler {
	runManager := a.Runs
	if runManager == nil {
		runManager = runs.NewManager(a.Store, a.Runner)
	}
	terminalManager := a.Terminals
	if terminalManager == nil {
		terminalManager = terminal.NewManager()
	}
	webFS := a.WebFS
	if webFS == nil {
		webFS = web.Files
	}
	api := &httpapi.API{
		Store:     a.Store,
		Runner:    a.Runner,
		Runs:      runManager,
		Terminals: terminalManager,
		WebFS:     webFS,
		Users:     a.Users,
	}
	mux := http.NewServeMux()
	api.Register(mux)
	return mux
}
