package app

import (
	"net/http"

	"tessera/internal/httpapi"
	"tessera/internal/shell"
	"tessera/internal/store"
)

type App struct {
	Store  *store.Store
	Runner *shell.Runner
	WebDir string
}

func (a *App) Handler() http.Handler {
	api := &httpapi.API{
		Store:  a.Store,
		Runner: a.Runner,
		WebDir: a.WebDir,
	}
	mux := http.NewServeMux()
	api.Register(mux)
	return mux
}
