package app

import (
	"io/fs"
	"net/http"

	"tessera/internal/httpapi"
	"tessera/internal/localhttps"
	"tessera/internal/rdpsession"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/update"
	"tessera/web"
)

type App struct {
	Store     *store.Store
	Terminals *terminal.Manager
	WebFS     fs.FS
	// Users is the optional multi-user roster, passed through to the API.
	Users []string
	// Updater optionally enables the self-update endpoint.
	Updater             *update.Updater
	MaxUploadBytes      int64
	HTTPSDefaultAddress string
	HTTPSPKIDir         string
	RequestRestart      func(localhttps.Config)
	// Auth configures sign-in; the zero value leaves it off.
	Auth httpapi.AuthOptions
	// Security configures origin checks, proxy trust, rate limiting, response
	// headers, and audit persistence around the complete application handler.
	Security httpapi.SecurityOptions
	// RDPSessions optionally keeps RDP sessions on the host.
	RDPSessions *rdpsession.Manager
}

func (a *App) Handler() http.Handler {
	terminalManager := a.Terminals
	if terminalManager == nil {
		terminalManager = terminal.NewManager()
	}
	webFS := a.WebFS
	if webFS == nil {
		webFS = web.Files
	}
	api := &httpapi.API{
		Store:               a.Store,
		Terminals:           terminalManager,
		WebFS:               webFS,
		Users:               a.Users,
		AuthMode:            a.Auth.Mode,
		Updater:             a.Updater,
		MaxUploadBytes:      a.MaxUploadBytes,
		HTTPSDefaultAddress: a.HTTPSDefaultAddress,
		HTTPSPKIDir:         a.HTTPSPKIDir,
		RequestRestart:      a.RequestRestart,
		RDPSessions:         a.RDPSessions,
	}
	mux := http.NewServeMux()
	api.Register(mux)
	// Sign-in runs inside the security handler, which resolves the client
	// address and scheme it relies on.
	authOptions := a.Auth
	if a.Security.AuditEnabled {
		authOptions.AuditRetention = a.Security.AuditRetention
	}
	authenticated := httpapi.NewAuthHandler(mux, a.Store, authOptions)
	return httpapi.NewSecurityHandler(httpapi.NewCompressionHandler(authenticated), a.Store, a.Security)
}
