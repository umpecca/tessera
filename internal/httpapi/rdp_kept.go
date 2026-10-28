package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"regexp"
	"strings"
	"time"

	"tessera/internal/rdpsession"
	"tessera/internal/store"
)

// Kept RDP sessions (task 238) run their RDP client on the host, so a session
// survives the browser that showed it. They need Tessera sign-in: a kept
// session is a logged-in desktop, and only its owner may reach it. They need
// HTTPS or loopback too, because the password comes to the host to log in.

const (
	rdpKeptMaxBody = 8 << 10
	// rdpKeptLoginTimeout bounds a create or rejoin request, which waits for
	// the server's login.
	rdpKeptLoginTimeout = 75 * time.Second
	rdpKeptMinSide      = 200
	rdpKeptMaxSide      = 8192
)

var rdpKeptPanePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

type rdpKeptRequest struct {
	WorkspaceID string `json:"workspaceId"`
	Pane        string `json:"pane"`
	Target      string `json:"target"`
	Fingerprint string `json:"fingerprint"`
	Username    string `json:"username"`
	Domain      string `json:"domain"`
	Password    string `json:"password"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	H264        bool   `json:"h264"`
}

type rdpKeptInfo struct {
	WorkspaceID string `json:"workspaceId"`
	Pane        string `json:"pane"`
	// Target is the server the session is for.
	Target    string `json:"target"`
	State     string `json:"state"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	CanRejoin bool   `json:"canRejoin"`
	Reason    string `json:"reason,omitempty"`
}

// rdpKeptOwner applies the kept-session rules and returns the owner: the
// signed-in account. It writes the refusal itself.
func (a *API) rdpKeptOwner(w http.ResponseWriter, r *http.Request) (string, bool) {
	if a.RDPSessions == nil {
		writeError(w, http.StatusNotFound, "kept RDP sessions are not available")
		return "", false
	}
	owner := SignedInAccount(r.Context())
	if a.AuthMode == "" || a.AuthMode == AuthOff || owner == "" {
		writeError(w, http.StatusForbidden, "keeping RDP sessions needs Tessera sign-in")
		return "", false
	}
	if !requestIsHTTPS(r) && !requestFromLoopback(r) {
		writeError(w, http.StatusForbidden, "keeping RDP sessions needs HTTPS")
		return "", false
	}
	return owner, true
}

func requestFromLoopback(r *http.Request) bool {
	addr, err := netip.ParseAddr(clientIP(r))
	return err == nil && addr.Unmap().IsLoopback()
}

// rdpKeptKey identifies a pane's kept session. Workspaces keep their own
// panes, so the key carries both.
func (a *API) rdpKeptKey(w http.ResponseWriter, r *http.Request, owner, workspaceID, pane string) (rdpsession.Key, bool) {
	if workspaceID == "" {
		workspaceID = store.DefaultWorkspaceID
	}
	if !rdpKeptPanePattern.MatchString(pane) || !rdpKeptPanePattern.MatchString(workspaceID) {
		writeError(w, http.StatusBadRequest, "invalid pane")
		return rdpsession.Key{}, false
	}
	if !a.workspaceAllowed(r.Context(), workspaceID) {
		writeError(w, http.StatusNotFound, "unknown session")
		return rdpsession.Key{}, false
	}
	return rdpsession.Key{Owner: owner, Pane: workspaceID + "/" + pane}, true
}

func decodeRDPKeptRequest(w http.ResponseWriter, r *http.Request) (rdpKeptRequest, bool) {
	var request rdpKeptRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, rdpKeptMaxBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid kept RDP session request")
		return request, false
	}
	return request, true
}

func rdpKeptInfoFor(key rdpsession.Key, target string, info rdpsession.Info) rdpKeptInfo {
	workspaceID, pane, _ := strings.Cut(key.Pane, "/")
	result := rdpKeptInfo{
		WorkspaceID: workspaceID,
		Pane:        pane,
		Target:      target,
		State:       info.State.String(),
		CanRejoin:   info.CanRejoin,
	}
	if info.State == rdpsession.StateActive || info.State == rdpsession.StateLost {
		result.Width, result.Height = info.Width, info.Height
	}
	if info.State != rdpsession.StateActive {
		result.Reason = limitText(info.Reason, 200)
	}
	return result
}

func limitText(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}

// rdpKeptLoginError maps a failed create or rejoin to a response.
func rdpKeptLoginError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, rdpsession.ErrExists):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, rdpsession.ErrCertificateChanged):
		writeError(w, http.StatusConflict, "the RDP server's certificate changed; check and trust it again")
	case errors.Is(err, rdpsession.ErrNotLost):
		writeError(w, http.StatusConflict, err.Error())
	case errors.Is(err, rdpsession.ErrManagerClosed), errors.Is(err, rdpsession.ErrClosed):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, rdpsession.ErrLoginTimeout), errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, "the RDP server took too long to log in")
	default:
		writeError(w, http.StatusBadGateway, "could not log in to the RDP server: "+limitText(err.Error(), 200))
	}
}

// rdpKept lists the caller's kept sessions (GET) or keeps a new one (POST).
func (a *API) rdpKept(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		owner, ok := a.rdpKeptOwner(w, r)
		if !ok {
			return
		}
		sessions := []rdpKeptInfo{}
		for _, key := range a.RDPSessions.Keys(owner) {
			workspaceID, _, _ := strings.Cut(key.Pane, "/")
			if !a.workspaceAllowed(r.Context(), workspaceID) {
				continue
			}
			if session, found := a.RDPSessions.Get(key); found {
				sessions = append(sessions, rdpKeptInfoFor(key, session.Address(), session.Info()))
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"sessions":         sessions,
			"idleLimitSeconds": int64(a.RDPSessions.IdleLimit() / time.Second),
		})
	case http.MethodPost:
		a.rdpKeptCreate(w, r)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func (a *API) rdpKeptCreate(w http.ResponseWriter, r *http.Request) {
	owner, ok := a.rdpKeptOwner(w, r)
	if !ok {
		return
	}
	request, ok := decodeRDPKeptRequest(w, r)
	if !ok {
		return
	}
	key, ok := a.rdpKeptKey(w, r, owner, request.WorkspaceID, request.Pane)
	if !ok {
		return
	}
	target, err := normalizeRDPTarget(request.Target)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	fingerprint := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(request.Fingerprint), ":", ""))
	if !rdpFingerprintPattern.MatchString(fingerprint) {
		writeError(w, http.StatusBadRequest, "a verified RDP server certificate fingerprint is required")
		return
	}
	if request.Username == "" || len(request.Username) > 256 || len(request.Domain) > 256 || len(request.Password) > 1024 {
		writeError(w, http.StatusBadRequest, "invalid RDP credentials")
		return
	}
	if request.Width < rdpKeptMinSide || request.Width > rdpKeptMaxSide || request.Height < rdpKeptMinSide || request.Height > rdpKeptMaxSide {
		writeError(w, http.StatusBadRequest, "invalid RDP desktop size")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), rdpKeptLoginTimeout)
	defer cancel()
	session, err := a.RDPSessions.Create(ctx, key, rdpsession.Target{
		Address:     target,
		Fingerprint: fingerprint,
		Username:    request.Username,
		Domain:      request.Domain,
		Width:       request.Width,
		Height:      request.Height,
		H264:        request.H264,
	}, request.Password, nil)
	if err != nil {
		rdpKeptLoginError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, rdpKeptInfoFor(key, session.Address(), session.Info()))
}

// rdpKeptAction handles /api/rdp-kept/rejoin, disconnect and view.
func (a *API) rdpKeptAction(w http.ResponseWriter, r *http.Request) {
	action := strings.TrimPrefix(r.URL.Path, "/api/rdp-kept/")
	if action == "view" {
		a.rdpKeptView(w, r)
		return
	}
	if action != "rejoin" && action != "disconnect" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	owner, ok := a.rdpKeptOwner(w, r)
	if !ok {
		return
	}
	request, ok := decodeRDPKeptRequest(w, r)
	if !ok {
		return
	}
	key, ok := a.rdpKeptKey(w, r, owner, request.WorkspaceID, request.Pane)
	if !ok {
		return
	}
	session, found := a.RDPSessions.Get(key)
	if !found {
		writeError(w, http.StatusNotFound, "no RDP session is kept for this pane")
		return
	}
	if action == "disconnect" {
		a.RDPSessions.Remove(key)
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), rdpKeptLoginTimeout)
	defer cancel()
	if err := session.Rejoin(ctx, request.Password); err != nil {
		rdpKeptLoginError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rdpKeptInfoFor(key, session.Address(), session.Info()))
}
