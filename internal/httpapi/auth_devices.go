package httpapi

import (
	"log"
	"net/http"
	"strings"

	"tessera/internal/store"
)

type signInView struct {
	ID         string `json:"id"`
	Current    bool   `json:"current"`
	Device     string `json:"device"`
	Remember   bool   `json:"remember"`
	CreatedAt  int64  `json:"createdAt"`
	LastSeenAt int64  `json:"lastSeenAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	CreatedIP  string `json:"createdIp"`
	LastIP     string `json:"lastIp"`
}

// signInsAPI lists the signed-in account's devices and ends them:
// GET /api/auth/sign-ins, DELETE /api/auth/sign-ins/{id}, and
// DELETE /api/auth/sign-ins for every device including this one.
func (g *authGate) signInsAPI(w http.ResponseWriter, r *http.Request, current store.SignIn) {
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/auth/sign-ins"), "/")
	switch r.Method {
	case http.MethodGet:
		if id != "" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		signIns, err := g.store.ListSignIns(r.Context(), current.Account, g.now())
		if err != nil {
			log.Printf("list sign-ins: %v", err)
			writeError(w, http.StatusInternalServerError, "could not list sign-ins")
			return
		}
		views := make([]signInView, 0, len(signIns))
		for _, signIn := range signIns {
			if !g.accountCurrent(r.Context(), signIn) {
				continue
			}
			views = append(views, signInView{
				ID: signIn.ID, Current: signIn.ID == current.ID, Device: describeDevice(signIn.UserAgent),
				Remember: signIn.Remember, CreatedAt: signIn.CreatedAt, LastSeenAt: signIn.LastSeenAt,
				ExpiresAt: min(signIn.ExpiresAt, signIn.LastSeenAt+signIn.IdleSeconds),
				CreatedIP: signIn.CreatedIP, LastIP: signIn.LastIP,
			})
		}
		writeJSON(w, http.StatusOK, map[string]any{"account": current.Account, "signIns": views})
	case http.MethodDelete:
		ended, err := g.store.RevokeAccountSignIns(r.Context(), current.Account, id, g.now())
		if err != nil {
			log.Printf("revoke sign-ins: %v", err)
			writeError(w, http.StatusInternalServerError, "could not end sign-ins")
			return
		}
		if id != "" && len(ended) == 0 {
			writeError(w, http.StatusNotFound, "sign-in not found")
			return
		}
		g.endSignIns(ended...)
		for _, endedID := range ended {
			if endedID == current.ID {
				http.SetCookie(w, &http.Cookie{Name: signInCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
					SameSite: http.SameSiteStrictMode, Secure: requestIsHTTPS(r)})
			}
		}
		g.noteAudit(r, current.ID, "")
		w.WriteHeader(http.StatusNoContent)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodDelete)
	}
}

// describeDevice turns a user agent into a short label such as
// "Safari on macOS". iPadOS Safari reports itself as macOS by default.
func describeDevice(agent string) string {
	browser := "Browser"
	switch {
	case strings.Contains(agent, "Edg/"):
		browser = "Edge"
	case strings.Contains(agent, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(agent, "Chrome/") || strings.Contains(agent, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(agent, "Safari/"):
		browser = "Safari"
	case strings.Contains(agent, "AppleWebKit/"):
		browser = "App"
	}
	system := ""
	switch {
	case strings.Contains(agent, "iPad"):
		system = "iPadOS"
	case strings.Contains(agent, "iPhone"):
		system = "iOS"
	case strings.Contains(agent, "Android"):
		system = "Android"
	case strings.Contains(agent, "Mac OS X") || strings.Contains(agent, "Macintosh"):
		system = "macOS"
	case strings.Contains(agent, "Windows"):
		system = "Windows"
	case strings.Contains(agent, "Linux"):
		system = "Linux"
	}
	if agent == "" {
		return "Unknown device"
	}
	if system == "" {
		return browser
	}
	return browser + " on " + system
}
