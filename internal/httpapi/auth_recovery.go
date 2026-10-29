package httpapi

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"tessera/internal/auth"
)

const (
	recoveryLinkLifetime = 2 * time.Minute
	maxRecoveryLinks     = 16
)

// recoveryLink is a single-use, short-lived sign-in issued to someone who
// proved they are on the host as the service account by reading its token.
type recoveryLink struct {
	account string
	expires time.Time
}

// hostCaller accepts a request only from this machine, directly rather than
// through a proxy, carrying the host recovery token.
func (g *authGate) hostCaller(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return false
	}
	peer, err := remoteIP(r.RemoteAddr)
	if err != nil || !peer.IsLoopback() || hasAnyHeader(r.Header, "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "Origin") {
		writeError(w, http.StatusForbidden, "only available from the host itself")
		return false
	}
	want, err := g.store.RecoveryToken(r.Context())
	if err != nil {
		log.Printf("host recovery token: %v", err)
		writeError(w, http.StatusServiceUnavailable, "host recovery token is unavailable")
		return false
	}
	got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid host recovery token")
		return false
	}
	return true
}

func (g *authGate) issueLink(w http.ResponseWriter, r *http.Request) {
	if !g.hostCaller(w, r) {
		return
	}
	var request struct {
		Account string `json:"account"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLoginBody)).Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid request")
		return
	}
	account := request.Account
	switch g.mode() {
	case AuthSystem:
		account = g.opts.SystemAccount
	case AuthFile:
		if _, ok := g.account(r.Context(), account); !ok {
			writeError(w, http.StatusBadRequest, "name an existing account with -account")
			return
		}
	}
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "could not create a link")
		return
	}
	code := hex.EncodeToString(raw[:])
	now := g.now()
	g.linksMu.Lock()
	for key, link := range g.links {
		if !now.Before(link.expires) {
			delete(g.links, key)
		}
	}
	if len(g.links) >= maxRecoveryLinks {
		g.linksMu.Unlock()
		writeError(w, http.StatusTooManyRequests, "too many unused links; wait two minutes")
		return
	}
	g.links[code] = recoveryLink{account: account, expires: now.Add(recoveryLinkLifetime)}
	g.linksMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"path": "/login/link?code=" + code, "account": account,
		"expiresInSeconds": int(recoveryLinkLifetime / time.Second)})
}

func (g *authGate) redeemLink(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, http.MethodGet)
		return
	}
	view := loginView{Host: g.host, Next: "/"}
	mode := g.mode()
	if mode == AuthSystem {
		view.FixedAccount = g.opts.SystemAccount
	}
	// The code is as good as a password, so it obeys the same transport rule.
	if !g.passwordTransportAllowed(r) {
		view.HTTPBlocked = true
		g.renderLogin(w, http.StatusForbidden, view)
		return
	}
	code := r.URL.Query().Get("code")
	g.linksMu.Lock()
	link, found := g.links[code]
	delete(g.links, code)
	g.linksMu.Unlock()
	if code == "" || !found || !g.now().Before(link.expires) {
		view.Error = "This sign-in link has expired or was already used. Run `tessera login` on the host for a new one."
		g.renderLogin(w, http.StatusUnauthorized, view)
		return
	}
	tag := ""
	if mode == AuthFile {
		account, ok := g.account(r.Context(), link.account)
		if !ok {
			view.Error = "That account no longer exists."
			g.renderLogin(w, http.StatusUnauthorized, view)
			return
		}
		tag = auth.CredentialTag(account.Hash)
	}
	secret, err := g.createSignIn(r, link.account, tag, false)
	if err != nil {
		log.Printf("create sign-in from link: %v", err)
		writeError(w, http.StatusInternalServerError, "could not sign in")
		return
	}
	g.setCookie(w, r, secret.value, secret.signIn)
	g.noteAudit(r, secret.signIn.ID, "")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func (g *authGate) revokeAll(w http.ResponseWriter, r *http.Request) {
	if !g.hostCaller(w, r) {
		return
	}
	count, err := g.store.RevokeAllSignIns(r.Context(), g.now())
	if err != nil {
		log.Printf("revoke all sign-ins: %v", err)
		writeError(w, http.StatusInternalServerError, "could not end sign-ins")
		return
	}
	g.endAllWatched()
	writeJSON(w, http.StatusOK, map[string]int64{"ended": count})
}
