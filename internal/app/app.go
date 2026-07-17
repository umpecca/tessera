package app

import (
	"io/fs"
	"net/http"

	"tessera/internal/audio"
	"tessera/internal/httpapi"
	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/update"
	"tessera/web"
)

type App struct {
	Store     *store.Store
	Runner    *shell.Runner
	Runs      *runs.Manager
	Terminals *terminal.Manager
	Audio     *audio.Manager
	WebFS     fs.FS
	// Users is the optional multi-user roster, passed through to the API.
	Users []string
	// Updater optionally enables the self-update endpoint.
	Updater        *update.Updater
	MaxUploadBytes int64
	// Security configures origin checks, proxy trust, rate limiting, response
	// headers, and audit persistence around the complete application handler.
	Security httpapi.SecurityOptions
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
	audioManager := a.Audio
	if audioManager == nil {
		audioManager = audio.NewManager(a.Store, terminalManager, audio.Options{})
	}
	webFS := a.WebFS
	if webFS == nil {
		webFS = web.Files
	}
	api := &httpapi.API{
		Store:          a.Store,
		Runner:         a.Runner,
		Runs:           runManager,
		Terminals:      terminalManager,
		Audio:          audioManager,
		WebFS:          webFS,
		Users:          a.Users,
		Updater:        a.Updater,
		MaxUploadBytes: a.MaxUploadBytes,
	}
	mux := http.NewServeMux()
	api.Register(mux)
	return httpapi.NewSecurityHandler(mux, a.Store, a.Security)
}
