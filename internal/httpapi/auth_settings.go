package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"time"

	"tessera/internal/auth"
	"tessera/internal/store"
)

const maxAccountBody = 8 << 10

var (
	errWrongPassword = errors.New("incorrect password")
	errLastAdmin     = errors.New("Tessera needs at least one admin account")
)

// authAdmin reports whether a sign-in may manage accounts and sign-in.
func (g *authGate) authAdmin(signIn store.SignIn) bool {
	return g.adminLocked(signIn, g.mode())
}

// workspaceOwner is whose workspaces the person at the keyboard sees in a
// mode: their account with Tessera accounts, otherwise the single-user
// workspaces. With -users there is no single owner.
func (g *authGate) workspaceOwner(mode, account string) string {
	switch {
	case g.opts.MultiUser:
		return ""
	case mode == AuthFile:
		return account
	}
	return store.DefaultWorkspaceID
}

type authSettingsView struct {
	Mode            string `json:"mode"`
	Locked          bool   `json:"locked"`
	CanManage       bool   `json:"canManage"`
	Account         string `json:"account"`
	SystemAccount   string `json:"systemAccount"`
	SystemAvailable bool   `json:"systemAvailable"`
	FileAvailable   bool   `json:"fileAvailable"`
	CanMove         bool   `json:"canMoveWorkspaces"`
	Exposed         bool   `json:"exposed"`
	NoAdmins        bool   `json:"noAdmins"`
	CredentialsPath string `json:"credentialsPath"`
}

// settingsAPI shows and changes the sign-in mode: GET and PUT
// /api/auth/settings. While sign-in is off anyone who can reach Tessera may
// turn it on; once on, only admins may change it.
func (g *authGate) settingsAPI(w http.ResponseWriter, r *http.Request, signIn store.SignIn) {
	switch r.Method {
	case http.MethodGet:
		mode := g.mode()
		view := authSettingsView{
			Mode: mode, Locked: g.opts.ModeLocked, Account: signIn.Account,
			CanManage:       mode == AuthOff || g.authAdmin(signIn),
			SystemAccount:   g.opts.SystemAccount,
			SystemAvailable: g.opts.SystemAccount != "" && g.opts.VerifySystem != nil,
			FileAvailable:   g.opts.Credentials != nil && !g.opts.MultiUser,
			CanMove:         !g.opts.MultiUser,
			Exposed:         listensBeyondHost(g.opts.ListenAddress),
		}
		if g.opts.Credentials != nil {
			view.CredentialsPath = g.opts.Credentials.Path()
			if mode == AuthFile {
				accounts, _ := g.opts.Credentials.Accounts()
				view.NoAdmins = !slices.ContainsFunc(accounts, func(a auth.Account) bool { return a.Admin })
			}
		}
		writeJSON(w, http.StatusOK, view)
	case http.MethodPut:
		g.changeMode(w, r, signIn)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPut)
	}
}

type modeChange struct {
	Mode string `json:"mode"`
	// Account and Password name the admin account to sign in as with
	// AuthFile, created if it doesn't exist; with AuthSystem, Password is
	// the host account's.
	Account  string `json:"account"`
	Password string `json:"password"`
	// CurrentPassword confirms turning sign-in off.
	CurrentPassword string `json:"currentPassword"`
	Remember        bool   `json:"remember"`
	MoveWorkspaces  bool   `json:"moveWorkspaces"`
}

func (g *authGate) changeMode(w http.ResponseWriter, r *http.Request, signIn store.SignIn) {
	var request modeChange
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAccountBody)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid sign-in settings")
		return
	}
	password, current := []byte(request.Password), []byte(request.CurrentPassword)
	request.Password, request.CurrentPassword = "", ""
	defer clear(password)
	defer clear(current)

	// Holding the mode for the whole change keeps two changes from
	// interleaving; requests in flight finish under the old mode.
	g.modeMu.Lock()
	defer g.modeMu.Unlock()
	from := g.current
	switch {
	case g.opts.ModeLocked:
		writeError(w, http.StatusConflict, "Sign-in is set with -auth when Tessera starts.")
		return
	case from != AuthOff && !g.adminLocked(signIn, from):
		writeError(w, http.StatusForbidden, "Only an admin can change sign-in.")
		return
	case request.Mode == from:
		writeError(w, http.StatusBadRequest, "Sign-in is already set that way.")
		return
	case !g.passwordTransportAllowed(r):
		writeError(w, http.StatusForbidden, "Changing sign-in from another device needs HTTPS.")
		return
	}
	if !g.beginPasswordCheck(w, r) {
		return
	}

	var account, tag string
	switch request.Mode {
	case AuthOff:
		if _, err := g.verify(r.Context(), from, signIn.Account, current); err != nil {
			g.passwordCheckFailed(w, r, err, "Incorrect password.")
			return
		}
	case AuthSystem:
		if g.opts.SystemAccount == "" || g.opts.VerifySystem == nil {
			writeError(w, http.StatusConflict, "This host can't check its account password.")
			return
		}
		if _, err := g.verify(r.Context(), AuthSystem, "", password); err != nil {
			g.passwordCheckFailed(w, r, err, "Incorrect password for "+g.opts.SystemAccount+".")
			return
		}
		account = g.opts.SystemAccount
	case AuthFile:
		if g.opts.Credentials == nil || g.opts.MultiUser {
			writeError(w, http.StatusConflict, "Tessera accounts can't be combined with -users.")
			return
		}
		if err := auth.ValidateName(request.Account); err != nil {
			writeError(w, http.StatusBadRequest, "Names must be 1-64 characters without spaces, '/', '\\' or ':'.")
			return
		}
		if err := auth.ValidatePassword(password); err != nil {
			writeError(w, http.StatusBadRequest, "Enter a password.")
			return
		}
		var err error
		tag, err = g.adoptAdmin(request.Account, password)
		if errors.Is(err, errWrongPassword) {
			g.passwordCheckFailed(w, r, err, "That account exists, and this isn't its password.")
			return
		}
		if err != nil {
			log.Printf("save admin account: %v", err)
			writeError(w, http.StatusInternalServerError, "could not save the account")
			return
		}
		account = request.Account
	default:
		writeError(w, http.StatusBadRequest, "Sign-in must be off, system or file.")
		return
	}
	g.throttle.Success(clientIP(r))

	if err := g.store.SaveSignInMode(r.Context(), request.Mode); err != nil {
		log.Printf("save sign-in mode: %v", err)
		writeError(w, http.StatusInternalServerError, "could not save sign-in settings")
		return
	}
	moved := false
	if request.MoveWorkspaces {
		previous := g.workspaceOwner(from, signIn.Account)
		next := g.workspaceOwner(request.Mode, account)
		if previous != "" && next != "" {
			var err error
			if moved, err = g.store.MoveUserData(r.Context(), previous, next); err != nil {
				log.Printf("move workspaces from %s to %s: %v", previous, next, err)
			}
		}
	}
	// Every earlier sign-in ends. Turning sign-in on also closes the
	// connections opened without one, this page's included; it reloads.
	if _, err := g.store.RevokeAllSignIns(r.Context(), g.now()); err != nil {
		log.Printf("revoke sign-ins: %v", err)
	}
	g.current = request.Mode
	log.Printf("sign-in changed from %s to %s in Settings", from, request.Mode)
	if request.Mode == AuthOff {
		g.clearCookie(w, r)
		g.noteAudit(r, signIn.ID, "sign-in off")
		writeJSON(w, http.StatusOK, map[string]any{"mode": request.Mode, "moved": moved})
		return
	}
	// The page learns of its new sign-in before its connections close.
	defer g.endAllWatched()
	secret, err := g.createSignIn(r, account, tag, request.Remember)
	if err != nil {
		log.Printf("create sign-in: %v", err)
		writeError(w, http.StatusInternalServerError, "Sign-in changed, but this device could not be signed in.")
		return
	}
	g.setCookie(w, r, secret.value, secret.signIn)
	g.noteAudit(r, secret.signIn.ID, "sign-in "+request.Mode)
	writeJSON(w, http.StatusOK, map[string]any{"mode": request.Mode, "account": account, "moved": moved})
	_ = http.NewResponseController(w).Flush()
}

// adminLocked is authAdmin for a caller already holding modeMu. The host
// account is the only identity in system mode, so it always may.
func (g *authGate) adminLocked(signIn store.SignIn, mode string) bool {
	switch mode {
	case AuthSystem:
		return signIn.Account != ""
	case AuthFile:
		account, ok := g.opts.Credentials.Lookup(signIn.Account)
		return ok && account.Admin
	}
	return false
}

// adoptAdmin makes name an admin account to sign in with: a new account
// with password, or an existing one whose password it is. It returns the
// sign-in's credential tag.
func (g *authGate) adoptAdmin(name string, password []byte) (string, error) {
	g.accountMu.Lock()
	defer g.accountMu.Unlock()
	var tag string
	err := g.opts.Credentials.Update(func(accounts []auth.Account) ([]auth.Account, error) {
		at := slices.IndexFunc(accounts, func(a auth.Account) bool { return a.Name == name })
		if at >= 0 {
			if ok, err := auth.VerifyPassword(accounts[at].Hash, password); err != nil || !ok {
				return nil, errWrongPassword
			}
			accounts[at].Admin = true
			tag = auth.CredentialTag(accounts[at].Hash)
			return accounts, nil
		}
		hash, err := auth.HashPassword(password)
		if err != nil {
			return nil, err
		}
		tag = auth.CredentialTag(hash)
		return append(accounts, auth.Account{Name: name, Hash: hash, Admin: true}), nil
	})
	return tag, err
}

// beginPasswordCheck applies sign-in throttling to settings that take a
// password.
func (g *authGate) beginPasswordCheck(w http.ResponseWriter, r *http.Request) bool {
	wait := g.throttle.Begin(clientIP(r), g.now())
	if wait <= 0 {
		return true
	}
	seconds := int((wait + time.Second - 1) / time.Second)
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	g.noteAudit(r, "", "throttled")
	writeJSON(w, http.StatusTooManyRequests, map[string]any{"error": "Too many attempts. Try again in " + formatWait(seconds) + ".", "retryAfter": seconds})
	return false
}

// passwordCheckFailed answers a refused password, which counts toward
// throttling, or a host that could not check one, which does not.
func (g *authGate) passwordCheckFailed(w http.ResponseWriter, r *http.Request, err error, message string) {
	if errors.Is(err, ErrSystemAuthUnavailable) {
		writeError(w, http.StatusServiceUnavailable, "This host could not check its account password.")
		return
	}
	g.throttle.Failure(clientIP(r), g.now())
	writeError(w, http.StatusUnauthorized, message)
}

func (g *authGate) clearCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: signInCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: requestIsHTTPS(r)})
}

type accountView struct {
	Name    string `json:"name"`
	Admin   bool   `json:"admin"`
	Current bool   `json:"current"`
}

type accountChange struct {
	Name     string `json:"name"`
	Password string `json:"password"`
	Admin    *bool  `json:"admin"`
}

// accountsAPI lets admins manage Tessera accounts while they are in use:
// GET and POST /api/auth/accounts, PATCH and DELETE /api/auth/accounts/{name}.
func (g *authGate) accountsAPI(w http.ResponseWriter, r *http.Request, signIn store.SignIn) {
	if g.mode() != AuthFile {
		writeError(w, http.StatusConflict, "Tessera accounts are not in use.")
		return
	}
	if !g.authAdmin(signIn) {
		writeError(w, http.StatusForbidden, "Only an admin can manage accounts.")
		return
	}
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/auth/accounts"), "/")
	switch {
	case name == "" && r.Method == http.MethodGet:
		accounts, err := g.opts.Credentials.Accounts()
		if err != nil {
			log.Printf("read accounts: %v", err)
			writeError(w, http.StatusInternalServerError, "could not read accounts")
			return
		}
		views := make([]accountView, 0, len(accounts))
		for _, account := range accounts {
			views = append(views, accountView{Name: account.Name, Admin: account.Admin, Current: account.Name == signIn.Account})
		}
		writeJSON(w, http.StatusOK, map[string]any{"accounts": views})
	case name == "" && r.Method == http.MethodPost:
		g.addAccount(w, r, signIn)
	case name != "" && r.Method == http.MethodPatch:
		g.changeAccount(w, r, signIn, name)
	case name != "" && r.Method == http.MethodDelete:
		g.removeAccount(w, r, signIn, name)
	case name == "":
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	default:
		methodNotAllowed(w, http.MethodPatch+", "+http.MethodDelete)
	}
}

func (g *authGate) decodeAccountChange(w http.ResponseWriter, r *http.Request) (accountChange, []byte, bool) {
	var request accountChange
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAccountBody)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid account")
		return request, nil, false
	}
	password := []byte(request.Password)
	request.Password = ""
	if len(password) > 0 && !g.passwordTransportAllowed(r) {
		clear(password)
		writeError(w, http.StatusForbidden, "Setting a password from another device needs HTTPS.")
		return request, nil, false
	}
	return request, password, true
}

func (g *authGate) addAccount(w http.ResponseWriter, r *http.Request, signIn store.SignIn) {
	request, password, ok := g.decodeAccountChange(w, r)
	if !ok {
		return
	}
	defer clear(password)
	if auth.ValidateName(request.Name) != nil {
		writeError(w, http.StatusBadRequest, "Names must be 1-64 characters without spaces, '/', '\\' or ':'.")
		return
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Enter a password.")
		return
	}
	g.accountMu.Lock()
	err = g.opts.Credentials.Update(func(accounts []auth.Account) ([]auth.Account, error) {
		if slices.ContainsFunc(accounts, func(a auth.Account) bool { return a.Name == request.Name }) {
			return nil, auth.ErrAccountExists
		}
		return append(accounts, auth.Account{Name: request.Name, Hash: hash, Admin: request.Admin != nil && *request.Admin}), nil
	})
	g.accountMu.Unlock()
	if errors.Is(err, auth.ErrAccountExists) {
		writeError(w, http.StatusConflict, "There is already an account named "+request.Name+".")
		return
	}
	if err != nil {
		log.Printf("add account: %v", err)
		writeError(w, http.StatusInternalServerError, "could not save the account")
		return
	}
	g.noteAudit(r, signIn.ID, "account added")
	writeJSON(w, http.StatusCreated, accountView{Name: request.Name, Admin: request.Admin != nil && *request.Admin})
}

// changeAccount sets a password, which ends that account's sign-ins except
// the caller's own, which is replaced, or grants or takes away admin.
func (g *authGate) changeAccount(w http.ResponseWriter, r *http.Request, signIn store.SignIn, name string) {
	request, password, ok := g.decodeAccountChange(w, r)
	if !ok {
		return
	}
	defer clear(password)
	newHash := ""
	if len(password) > 0 {
		var err error
		if newHash, err = auth.HashPassword(password); err != nil {
			writeError(w, http.StatusBadRequest, "Passwords must be 1-1024 bytes.")
			return
		}
	}
	if newHash == "" && request.Admin == nil {
		writeError(w, http.StatusBadRequest, "Nothing to change.")
		return
	}
	var updated auth.Account
	g.accountMu.Lock()
	err := g.opts.Credentials.Update(func(accounts []auth.Account) ([]auth.Account, error) {
		at := slices.IndexFunc(accounts, func(a auth.Account) bool { return a.Name == name })
		if at < 0 {
			return nil, auth.ErrNoAccount
		}
		if newHash != "" {
			accounts[at].Hash = newHash
		}
		if request.Admin != nil {
			accounts[at].Admin = *request.Admin
			if !slices.ContainsFunc(accounts, func(a auth.Account) bool { return a.Admin }) {
				return nil, errLastAdmin
			}
		}
		updated = accounts[at]
		return accounts, nil
	})
	g.accountMu.Unlock()
	if !g.accountWriteOK(w, err) {
		return
	}
	if newHash != "" {
		own := name == signIn.Account
		spare := ""
		if own {
			spare = signIn.ID
		}
		g.endAccountSignIns(r.Context(), name, spare)
		if own {
			// Replace this device's sign-in so its connections stay open.
			replacement, err := g.createSignIn(r, name, auth.CredentialTag(updated.Hash), signIn.Remember)
			if err != nil {
				log.Printf("replace sign-in: %v", err)
				g.endSignIns(signIn.ID)
			} else {
				g.setCookie(w, r, replacement.value, replacement.signIn)
				g.moveWatches(signIn.ID, replacement.signIn.ID)
			}
		}
	}
	g.noteAudit(r, signIn.ID, "account changed")
	writeJSON(w, http.StatusOK, accountView{Name: updated.Name, Admin: updated.Admin, Current: name == signIn.Account})
}

func (g *authGate) removeAccount(w http.ResponseWriter, r *http.Request, signIn store.SignIn, name string) {
	if name == signIn.Account {
		writeError(w, http.StatusConflict, "You can't remove the account you're signed in as.")
		return
	}
	g.accountMu.Lock()
	err := g.opts.Credentials.Update(func(accounts []auth.Account) ([]auth.Account, error) {
		at := slices.IndexFunc(accounts, func(a auth.Account) bool { return a.Name == name })
		if at < 0 {
			return nil, auth.ErrNoAccount
		}
		accounts = slices.Delete(accounts, at, at+1)
		if !slices.ContainsFunc(accounts, func(a auth.Account) bool { return a.Admin }) {
			return nil, errLastAdmin
		}
		return accounts, nil
	})
	g.accountMu.Unlock()
	if !g.accountWriteOK(w, err) {
		return
	}
	g.endAccountSignIns(r.Context(), name, "")
	g.noteAudit(r, signIn.ID, "account removed")
	w.WriteHeader(http.StatusNoContent)
}

func (g *authGate) accountWriteOK(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return true
	case errors.Is(err, auth.ErrNoAccount):
		writeError(w, http.StatusNotFound, "no such account")
	case errors.Is(err, errLastAdmin):
		writeError(w, http.StatusConflict, errLastAdmin.Error()+".")
	default:
		log.Printf("change account: %v", err)
		writeError(w, http.StatusInternalServerError, "could not save the account")
	}
	return false
}

// endAccountSignIns ends an account's sign-ins and closes their
// connections at once rather than at the next check, apart from those of
// spare, which the caller hands to a replacement sign-in.
func (g *authGate) endAccountSignIns(ctx context.Context, account, spare string) {
	ended, err := g.store.RevokeAccountSignIns(ctx, account, "", g.now())
	if err != nil {
		log.Printf("revoke sign-ins of %s: %v", account, err)
		return
	}
	g.endSignIns(slices.DeleteFunc(ended, func(id string) bool { return id == spare })...)
}

// listensBeyondHost reports whether a listen address can be reached from
// other devices.
func listensBeyondHost(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		host = address
	}
	if host == "localhost" {
		return false
	}
	addr, err := netip.ParseAddr(host)
	return err != nil || !addr.IsLoopback()
}
