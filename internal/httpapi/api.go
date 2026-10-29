package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"sync"

	"tessera/internal/localhttps"
	"tessera/internal/rdpsession"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/update"
	"tessera/internal/version"
)

type API struct {
	Store     *store.Store
	Terminals *terminal.Manager
	WebFS     fs.FS
	// Users is the roster for multi-user mode. When empty, Tessera runs in
	// single-user mode with just the default workspace.
	Users []string
	// AuthMode is AuthOff, AuthFile or AuthSystem. With AuthFile the signed-in
	// account is the only user a request may reach. Requests that passed the
	// sign-in gate use its current mode instead, which Settings can change.
	AuthMode string
	// Updater enables the self-update endpoint; nil makes /api/update report
	// the feature as unavailable.
	Updater *update.Updater
	// MaxUploadBytes limits one streamed terminal file upload. Values at or below
	// zero use DefaultMaxUploadBytes.
	MaxUploadBytes int64
	// HTTPSDefaultAddress and HTTPSPKIDir back the host-level Local HTTPS
	// settings endpoint. RequestRestart applies saved listener changes without
	// requiring service-manager privileges.
	HTTPSDefaultAddress string
	HTTPSPKIDir         string
	RequestRestart      func(localhttps.Config)
	// RDPSessions keeps RDP sessions on the host while no browser shows them
	// (task 238). Nil turns the kept-session endpoints off.
	RDPSessions *rdpsession.Manager

	browserProxyOnce sync.Once
	browserProxy     *browserProxyManager
	vncProxyOnce     sync.Once
	vncProxy         *vncProxyManager
	rdpProxyOnce     sync.Once
	rdpProxy         *rdpProxyManager

	hostClipboardMu   sync.Mutex
	hostClipboardLast *hostClipboardWrite
	savedHostFiles    savedHostFiles
}

func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("/api/health", a.health)
	mux.HandleFunc("/api/users", a.users)
	mux.HandleFunc("/api/users/", a.userResources)
	mux.HandleFunc("/api/workspace/", a.workspace)
	mux.HandleFunc("/api/terminal", a.terminalSession)
	mux.HandleFunc("/api/directories", a.listDirectories)
	mux.HandleFunc("/api/terminal-files/claim", a.claimTerminalFiles)
	mux.HandleFunc("/api/terminal-files/frame", a.terminalFileFrame)
	mux.HandleFunc("/api/terminal-files/upload", a.uploadTerminalFile)
	mux.HandleFunc("/api/terminal-files/download", a.downloadTerminalFiles)
	mux.HandleFunc("/api/terminal-files/result", a.terminalFileResult)
	mux.HandleFunc("/api/terminal-files/finish", a.finishTerminalFiles)
	mux.HandleFunc("/api/terminal-files/cancel", a.cancelTerminalFiles)
	mux.HandleFunc("/api/update", a.selfUpdate)
	mux.HandleFunc("/api/host/https", a.localHTTPSSettings)
	mux.HandleFunc("/api/host/https/ca", a.localHTTPSRootCertificate)
	mux.HandleFunc("/api/host/clipboard", a.hostClipboard)
	mux.HandleFunc("/api/host/files", a.saveHostFile)
	mux.HandleFunc("/api/host/files/delete", a.deleteHostFiles)
	mux.HandleFunc("/api/host/attachments", a.uploadAttachment)
	mux.HandleFunc("/local-https/", a.localHTTPSEnrollment)
	mux.HandleFunc("/api/rdp-kept", a.rdpKept)
	mux.HandleFunc("/api/rdp-kept/", a.rdpKeptAction)
	mux.HandleFunc("/api/browser-proxy", a.browserProxyControl)
	mux.HandleFunc("/api/browser-proxy/", a.browserProxyControl)
	mux.HandleFunc("/browser-proxy/", a.browserProxyRequest)
	mux.HandleFunc("/api/vnc-proxy", a.vncProxyCreate)
	mux.HandleFunc("/api/vnc-proxy/connect", a.vncProxyConnect)
	mux.HandleFunc("/api/rdp-proxy", a.rdpProxyCreate)
	mux.HandleFunc("/api/rdp-proxy/certificate", a.rdpProxyCertificate)
	mux.HandleFunc("/api/rdp-proxy/connect/", a.rdpProxyConnect)
	mux.HandleFunc("/", a.staticFiles())
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": version.Version})
}

// users reports whether multi-user mode is enabled and, if so, the roster the
// selection screen should offer.
func (a *API) users(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	roster := a.roster(r.Context())
	if roster == nil {
		roster = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"enabled":  len(roster) > 0,
		"users":    roster,
		"auth":     a.authMode(r.Context()),
		"signedIn": SignedInAccount(r.Context()),
	})
}

func (a *API) authMode(ctx context.Context) string {
	if gate, ok := ctx.Value(gateKey{}).(*authGate); ok {
		return gate.mode()
	}
	if a.AuthMode == "" {
		return AuthOff
	}
	return a.AuthMode
}

// roster is the users a request may reach: the signed-in account with file
// sign-in, otherwise the configured -users roster.
func (a *API) roster(ctx context.Context) []string {
	if a.authMode(ctx) == AuthFile {
		if account := SignedInAccount(ctx); account != "" {
			return []string{account}
		}
		return nil
	}
	return a.Users
}

// userAllowed reports whether a session owner is one of the users this
// request may reach. Single-user mode uses the synthetic "default" owner.
func (a *API) userAllowed(ctx context.Context, id string) bool {
	roster := a.roster(ctx)
	if len(roster) == 0 {
		return a.authMode(ctx) != AuthFile && (id == "" || id == store.DefaultWorkspaceID)
	}
	for _, user := range roster {
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
		return a.userAllowed(ctx, ownerID)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false
	}
	// The first workspace historically used its user id as its workspace id.
	// Allow that one missing row so first-load creation remains compatible.
	return a.userAllowed(ctx, id)
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
