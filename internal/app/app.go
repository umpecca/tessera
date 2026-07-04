package app

import (
	"net/http"

	"tessera/internal/httpapi"
	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
)

type App struct {
	Store     *store.Store
	Runner    *shell.Runner
	Runs      *runs.Manager
	Terminals *terminal.Manager
	WebDir    string
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
	api := &httpapi.API{
		Store:     a.Store,
		Runner:    a.Runner,
		Runs:      runManager,
		Terminals: terminalManager,
		WebDir:    a.WebDir,
	}
	mux := http.NewServeMux()
	api.Register(mux)
	return mux
}
