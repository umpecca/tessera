package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"tessera/internal/auth"
	"tessera/internal/store"
)

// Sign-in modes. Off is the default and leaves every request unauthenticated.
const (
	AuthOff    = "off"
	AuthFile   = "file"
	AuthSystem = "system"
)

const (
	signInCookie        = "tessera_signin"
	browserIdle         = 12 * time.Hour
	browserMax          = 7 * 24 * time.Hour
	DefaultRememberIdle = 30 * 24 * time.Hour
	DefaultRememberMax  = 90 * 24 * time.Hour
	signInTouchInterval = time.Hour
	signInCleanup       = time.Hour
	maxLoginBody        = 8 << 10
)

// ErrSystemAuthUnavailable means the host cannot check the system password
// here, as distinct from an incorrect one.
var ErrSystemAuthUnavailable = errors.New("system password verification is unavailable")

type AuthOptions struct {
	// Mode is the sign-in mode Tessera starts with. Admins can change it in
	// Settings unless ModeLocked, which -auth sets.
	Mode       string
	ModeLocked bool
	// MultiUser is set by -users, which keeps workspaces per roster name and
	// so cannot be combined with AuthFile.
	MultiUser bool
	// ListenAddress is the main listener, used to warn before sign-in is
	// turned off on a server other devices can reach.
	ListenAddress string
	// SystemAccount and VerifySystem serve AuthSystem. VerifySystem returns
	// nil for the correct password, ErrSystemAuthUnavailable when it cannot
	// check, and any other error for an incorrect one.
	// SystemAccount is "" when the host account could not be found.
	SystemAccount string
	VerifySystem  func(ctx context.Context, password []byte) error
	// AllowHTTPSignIn accepts passwords over plain HTTP from other devices,
	// for links that are already encrypted, such as a VPN.
	AllowHTTPSignIn bool
	// AuditRetention, when positive, records sign-ins that end while their
	// connections are open (expiry, password change) in the audit log.
	AuditRetention time.Duration
	RememberIdle   time.Duration
	RememberMax    time.Duration
}

// CheckMode reports why the server could not start with a sign-in mode.
// Missing accounts are not such a reason: the server starts with nobody
// able to sign in, and AccountsProblem says why until there are some.
func (o AuthOptions) CheckMode(mode string) error {
	switch mode {
	case AuthOff:
		return nil
	case AuthSystem:
		if o.SystemAccount == "" {
			return errors.New("the account Tessera runs as could not be found")
		}
		return nil
	case AuthFile:
		if o.MultiUser {
			return errors.New("-users cannot be combined with -auth=file: each Tessera account is a user")
		}
		return nil
	}
	return fmt.Errorf("-auth must be off, system or file, not %q", mode)
}

// AccountsProblem reports why nobody can sign in with Tessera accounts:
// there are none yet, or they can't be read.
func AccountsProblem(ctx context.Context, st *store.Store) error {
	accounts, err := st.Accounts(ctx)
	if err != nil {
		return fmt.Errorf("the accounts can't be read: %w", err)
	}
	if len(accounts) == 0 {
		return errors.New("there are no accounts yet; on the host, run: tessera user add <name>")
	}
	return nil
}

//go:embed login.html
var loginPageSource string

var loginPage = template.Must(template.New("login").Parse(loginPageSource))

type authGate struct {
	next  http.Handler
	store *store.Store
	opts  AuthOptions
	// modeMu guards the current mode, which starts as opts.Mode. Changes
	// hold it for writing until their sign-ins are in place.
	modeMu    sync.RWMutex
	current   string
	accountMu sync.Mutex
	throttle  *auth.Throttle
	verifyMu  sync.Mutex
	dummyHash string
	host      string
	now       func() time.Time

	linksMu sync.Mutex
	links   map[string]recoveryLink

	watchMu  sync.Mutex
	watches  map[string]map[*signInWatch]struct{}
	watching bool

	cleanupMu   sync.Mutex
	lastCleanup time.Time
}

type signInKey struct{}

// SignedInAccount returns the account a request was authenticated as, or ""
// when sign-in is off.
func SignedInAccount(ctx context.Context) string {
	signIn, _ := ctx.Value(signInKey{}).(store.SignIn)
	return signIn.Account
}

// NewAuthHandler requires a sign-in for everything except the login page and
// the few resources reachable before it. With AuthOff it passes requests on
// untouched, apart from the sign-in settings, until Settings turns it on.
func NewAuthHandler(next http.Handler, st *store.Store, opts AuthOptions) http.Handler {
	if opts.Mode == "" {
		opts.Mode = AuthOff
	}
	if opts.RememberIdle <= 0 {
		opts.RememberIdle = DefaultRememberIdle
	}
	if opts.RememberMax <= 0 {
		opts.RememberMax = DefaultRememberMax
	}
	host, _ := os.Hostname()
	// Unknown names are checked against a real hash, so a wrong name takes
	// as long to reject as a wrong password.
	dummy, err := auth.HashPassword([]byte("tessera-unknown-account"))
	if err != nil {
		panic(err)
	}
	return &authGate{next: next, store: st, opts: opts, current: opts.Mode, throttle: auth.NewThrottle(), dummyHash: dummy, host: host, now: time.Now,
		links: map[string]recoveryLink{}, watches: map[string]map[*signInWatch]struct{}{}}
}

func (g *authGate) mode() string {
	g.modeMu.RLock()
	defer g.modeMu.RUnlock()
	return g.current
}

func (g *authGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.mode() == AuthOff {
		if r.URL.Path == "/api/auth/settings" {
			if stateChangingMethod(r.Method) && !requestOriginAllowed(r) {
				writeError(w, http.StatusForbidden, "request origin is not allowed")
				return
			}
			g.settingsAPI(w, r, store.SignIn{})
			return
		}
		// The gate rides along so connections opened now can be closed if
		// sign-in is turned on.
		g.next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), gateKey{}, g)))
		return
	}
	switch r.URL.Path {
	case "/login":
		g.login(w, r)
		return
	case "/logout":
		g.logout(w, r)
		return
	case "/login/link":
		g.redeemLink(w, r)
		return
	case "/api/auth/recovery-link":
		g.issueLink(w, r)
		return
	case "/api/auth/revoke-all":
		g.revokeAll(w, r)
		return
	case "/api/auth/login":
		g.loginAPI(w, r)
		return
	}
	g.cleanup()
	signIn, ok := g.currentSignIn(w, r)
	if ok {
		g.noteAudit(r, signIn.ID, "")
		if path := r.URL.Path; path == "/api/auth/sign-ins" || strings.HasPrefix(path, "/api/auth/sign-ins/") ||
			path == "/api/auth/settings" || path == "/api/auth/accounts" || strings.HasPrefix(path, "/api/auth/accounts/") {
			if stateChangingMethod(r.Method) && !requestOriginAllowed(r) {
				writeError(w, http.StatusForbidden, "request origin is not allowed")
				return
			}
			switch {
			case strings.HasPrefix(path, "/api/auth/sign-ins"):
				g.signInsAPI(w, r, signIn)
			case path == "/api/auth/settings":
				g.settingsAPI(w, r, signIn)
			default:
				g.accountsAPI(w, r, signIn)
			}
			return
		}
		ctx := context.WithValue(context.WithValue(r.Context(), signInKey{}, signIn), gateKey{}, g)
		g.next.ServeHTTP(w, r.WithContext(ctx))
		return
	}
	if publicPath(r.URL.Path) {
		g.next.ServeHTTP(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		writeError(w, http.StatusUnauthorized, "sign-in required")
		return
	}
	http.Redirect(w, r, "/login?next="+url.QueryEscape(r.URL.RequestURI()), http.StatusSeeOther)
}

// publicPath lists what a signed-out browser may load: health checks, the
// Local HTTPS enrollment it needs before it can sign in safely, static assets
// for the login page and home-screen icon, and Browser pane traffic, whose
// unguessable proxy ID is its capability and whose cookies are stripped, with
// its site data (browser_site_data.go).
func publicPath(path string) bool {
	switch path {
	case "/api/health", "/api/host/https/ca", "/manifest.webmanifest":
		return true
	}
	return strings.HasPrefix(path, "/local-https/") || strings.HasPrefix(path, "/assets/") ||
		strings.HasPrefix(path, browserProxyPrefix) || strings.HasPrefix(path, browserProxyStatePrefix)
}

func (g *authGate) currentSignIn(w http.ResponseWriter, r *http.Request) (store.SignIn, bool) {
	cookie, err := r.Cookie(signInCookie)
	if err != nil || cookie.Value == "" || len(cookie.Value) > 128 {
		return store.SignIn{}, false
	}
	now := g.now()
	signIn, err := g.store.SignInBySecretHash(r.Context(), secretHash(cookie.Value), now)
	if err != nil {
		if !errors.Is(err, store.ErrSignInInvalid) {
			log.Printf("load sign-in: %v", err)
		}
		return store.SignIn{}, false
	}
	if !g.accountCurrent(r.Context(), signIn) {
		return store.SignIn{}, false
	}
	if now.Unix()-signIn.LastSeenAt >= int64(signInTouchInterval/time.Second) {
		if err := g.store.TouchSignIn(r.Context(), signIn.ID, now, clientIP(r)); err != nil {
			log.Printf("touch sign-in: %v", err)
		}
		if signIn.Remember {
			g.setCookie(w, r, cookie.Value, signIn)
		}
	}
	return signIn, true
}

// accountCurrent ends sign-ins whose account was removed or whose password
// changed since they were made. Only file sign-ins carry a credential tag,
// so a sign-in never outlives a change between modes.
func (g *authGate) accountCurrent(ctx context.Context, signIn store.SignIn) bool {
	switch g.mode() {
	case AuthFile:
		account, ok := g.account(ctx, signIn.Account)
		return ok && signIn.CredentialTag != "" && auth.CredentialTag(account.Hash) == signIn.CredentialTag
	case AuthSystem:
		return signIn.Account == g.opts.SystemAccount && signIn.CredentialTag == ""
	}
	return false
}

// account looks up one of Tessera's own accounts. One that can't be read
// is not found, so nobody signs in as it.
func (g *authGate) account(ctx context.Context, name string) (auth.Account, bool) {
	account, ok, err := g.store.Account(ctx, name)
	if err != nil {
		log.Printf("read account: %v", err)
	}
	return account, ok
}

const unavailableMessage = "This host could not check its account password. On the host, run `tessera login` for a one-time sign-in link, or start Tessera with -auth=file."

type loginView struct {
	Host, FixedAccount, Username, Next, Error, Unavailable, HTTPSURL string
	Remember, HTTPBlocked                                            bool
	RetryAfter                                                       int
}

func (g *authGate) login(w http.ResponseWriter, r *http.Request) {
	view := loginView{Host: g.host, Next: safeNext(r.URL.Query().Get("next"))}
	switch g.mode() {
	case AuthSystem:
		view.FixedAccount = g.opts.SystemAccount
		if g.opts.VerifySystem == nil {
			view.Unavailable = unavailableMessage
		}
	case AuthFile:
		if err := AccountsProblem(r.Context(), g.store); err != nil {
			view.Unavailable = "Nobody can sign in: " + err.Error() + ". Reload this page once that is done."
		}
	}
	view.HTTPBlocked = !g.passwordTransportAllowed(r)
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if _, ok := g.currentSignIn(w, r); ok {
			http.Redirect(w, r, view.Next, http.StatusSeeOther)
			return
		}
		g.renderLogin(w, http.StatusOK, view)
	case http.MethodPost:
		g.submitLogin(w, r, view)
	default:
		methodNotAllowed(w, http.MethodGet+", "+http.MethodPost)
	}
}

func (g *authGate) submitLogin(w http.ResponseWriter, r *http.Request, view loginView) {
	if !requestOriginAllowed(r) {
		writeError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxLoginBody)
	if err := r.ParseForm(); err != nil {
		writeError(w, http.StatusBadRequest, "invalid sign-in form")
		return
	}
	view.Username, view.Remember = strings.TrimSpace(r.PostForm.Get("username")), r.PostForm.Get("remember") == "1"
	view.Next = safeNext(r.PostForm.Get("next"))
	password := []byte(r.PostForm.Get("password"))
	defer clear(password)
	attempt := g.attemptSignIn(w, r, view.Username, password, view.Remember)
	switch attempt.status {
	case http.StatusSeeOther:
		http.Redirect(w, r, view.Next, http.StatusSeeOther)
		return
	case http.StatusInternalServerError:
		writeError(w, attempt.status, attempt.message)
		return
	case http.StatusForbidden:
		view.HTTPBlocked = true
	case http.StatusServiceUnavailable:
		view.Unavailable = attempt.message
	case http.StatusTooManyRequests:
		view.RetryAfter = attempt.retryAfter
		view.Error = attempt.message
	default:
		view.Error = attempt.message
	}
	g.renderLogin(w, attempt.status, view)
}

// loginAPI is the JSON form of sign-in used by the workspace's sign-in
// dialog, so an ended sign-in can be renewed without leaving the page.
func (g *authGate) loginAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requestOriginAllowed(r) {
		writeError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	var request struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Remember bool   `json:"remember"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLoginBody)).Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid sign-in request")
		return
	}
	password := []byte(request.Password)
	request.Password = ""
	defer clear(password)
	attempt := g.attemptSignIn(w, r, strings.TrimSpace(request.Username), password, request.Remember)
	if attempt.status == http.StatusSeeOther {
		writeJSON(w, http.StatusOK, map[string]string{"account": attempt.account})
		return
	}
	body := map[string]any{"error": attempt.message}
	if attempt.retryAfter > 0 {
		body["retryAfter"] = attempt.retryAfter
	}
	writeJSON(w, attempt.status, body)
}

type signInAttempt struct {
	status     int
	message    string
	retryAfter int
	account    string
}

// attemptSignIn applies the transport rule and throttling, checks the
// password, and on success creates the sign-in and sets its cookie. Success
// is reported as 303 See Other.
func (g *authGate) attemptSignIn(w http.ResponseWriter, r *http.Request, name string, password []byte, remember bool) signInAttempt {
	if !g.passwordTransportAllowed(r) {
		return signInAttempt{status: http.StatusForbidden, message: "Signing in from another device needs HTTPS."}
	}
	mode := g.mode()
	if mode == AuthSystem {
		if g.opts.VerifySystem == nil {
			return signInAttempt{status: http.StatusServiceUnavailable, message: unavailableMessage}
		}
		name = g.opts.SystemAccount
	}
	client := clientIP(r)
	if wait := g.throttle.Begin(client, g.now()); wait > 0 {
		seconds := int((wait + time.Second - 1) / time.Second)
		w.Header().Set("Retry-After", strconv.Itoa(seconds))
		g.noteAudit(r, "", "throttled")
		return signInAttempt{status: http.StatusTooManyRequests, retryAfter: seconds,
			message: "Too many attempts. Try again in " + formatWait(seconds) + "."}
	}
	tag, err := g.verify(r.Context(), mode, name, password)
	if errors.Is(err, ErrSystemAuthUnavailable) {
		return signInAttempt{status: http.StatusServiceUnavailable, message: unavailableMessage}
	}
	if err != nil {
		g.throttle.Failure(client, g.now())
		message := "Incorrect name or password."
		if mode == AuthSystem {
			message = "Incorrect password."
		}
		return signInAttempt{status: http.StatusUnauthorized, message: message}
	}
	g.throttle.Success(client)
	secret, err := g.createSignIn(r, name, tag, remember)
	if err != nil {
		log.Printf("create sign-in: %v", err)
		return signInAttempt{status: http.StatusInternalServerError, message: "could not sign in"}
	}
	g.setCookie(w, r, secret.value, secret.signIn)
	g.noteAudit(r, secret.signIn.ID, "")
	return signInAttempt{status: http.StatusSeeOther, account: name}
}

// verify checks one password at a time against mode's accounts and returns
// the credential tag the new sign-in should carry.
func (g *authGate) verify(ctx context.Context, mode, name string, password []byte) (string, error) {
	g.verifyMu.Lock()
	defer g.verifyMu.Unlock()
	if auth.ValidatePassword(password) != nil {
		return "", errors.New("incorrect")
	}
	switch mode {
	case AuthFile:
		account, found := g.account(ctx, name)
		hash := g.dummyHash
		if found {
			hash = account.Hash
		}
		ok, err := auth.VerifyPassword(hash, password)
		if err != nil || !ok || !found {
			return "", errors.New("incorrect")
		}
		return auth.CredentialTag(account.Hash), nil
	case AuthSystem:
		if g.opts.VerifySystem == nil {
			return "", ErrSystemAuthUnavailable
		}
		verifyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if err := g.opts.VerifySystem(verifyCtx, password); err != nil {
			return "", err
		}
		return "", nil
	}
	return "", ErrSystemAuthUnavailable
}

type newSignIn struct {
	value  string
	signIn store.SignIn
}

func (g *authGate) createSignIn(r *http.Request, account, tag string, remember bool) (newSignIn, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return newSignIn{}, err
	}
	value := hex.EncodeToString(raw[:])
	idle, lifetime := browserIdle, browserMax
	if remember {
		idle, lifetime = g.opts.RememberIdle, g.opts.RememberMax
	}
	now := g.now()
	signIn := store.SignIn{
		ID: newRequestID(), SecretHash: secretHash(value), Account: account, CredentialTag: tag,
		Remember: remember, CreatedAt: now.Unix(), LastSeenAt: now.Unix(),
		ExpiresAt: now.Add(lifetime).Unix(), IdleSeconds: int64(idle / time.Second),
		CreatedIP: clientIP(r), UserAgent: summarizeUserAgent(r.UserAgent()), LastIP: clientIP(r),
	}
	if err := g.store.CreateSignIn(r.Context(), signIn); err != nil {
		return newSignIn{}, err
	}
	return newSignIn{value: value, signIn: signIn}, nil
}

func (g *authGate) setCookie(w http.ResponseWriter, r *http.Request, value string, signIn store.SignIn) {
	cookie := &http.Cookie{
		Name: signInCookie, Value: value, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: requestIsHTTPS(r),
	}
	if signIn.Remember {
		// The browser keeps the cookie no longer than the server would honor it.
		remaining := min(signIn.ExpiresAt, g.now().Unix()+signIn.IdleSeconds) - g.now().Unix()
		cookie.MaxAge = int(max(remaining, 1))
	}
	http.SetCookie(w, cookie)
}

func (g *authGate) logout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w, http.MethodPost)
		return
	}
	if !requestOriginAllowed(r) {
		writeError(w, http.StatusForbidden, "request origin is not allowed")
		return
	}
	if signIn, ok := g.currentSignIn(w, r); ok {
		if err := g.store.RevokeSignIn(r.Context(), signIn.ID, g.now()); err != nil {
			log.Printf("revoke sign-in: %v", err)
		}
		g.endSignIns(signIn.ID)
		g.noteAudit(r, signIn.ID, "")
	}
	http.SetCookie(w, &http.Cookie{Name: signInCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true,
		SameSite: http.SameSiteStrictMode, Secure: requestIsHTTPS(r)})
	w.WriteHeader(http.StatusNoContent)
}

func (g *authGate) renderLogin(w http.ResponseWriter, status int, view loginView) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	// Under the site-wide no-referrer policy a form post carries
	// "Origin: null", which the origin check must refuse. Same-origin keeps
	// the real origin on this page's own post and still sends nothing away.
	w.Header().Set("Referrer-Policy", "same-origin")
	w.WriteHeader(status)
	if err := loginPage.Execute(w, view); err != nil {
		log.Printf("render login page: %v", err)
	}
}

// passwordTransportAllowed refuses passwords sent in the clear from another
// device. Loopback never leaves the host; -allow-http-sign-in covers links
// encrypted underneath HTTP.
func (g *authGate) passwordTransportAllowed(r *http.Request) bool {
	if requestIsHTTPS(r) || g.opts.AllowHTTPSignIn {
		return true
	}
	addr, err := netip.ParseAddr(clientIP(r))
	return err == nil && addr.IsLoopback()
}

func (g *authGate) cleanup() {
	g.cleanupMu.Lock()
	now := g.now()
	due := now.Sub(g.lastCleanup) >= signInCleanup
	if due {
		g.lastCleanup = now
	}
	g.cleanupMu.Unlock()
	if !due {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := g.store.RemoveEndedSignIns(ctx, now.Add(-24*time.Hour)); err != nil {
			log.Printf("remove ended sign-ins: %v", err)
		}
	}()
}

// noteAudit records which sign-in a request created or ended, and outcomes
// such as throttling, in its audit event when auditing is on.
func (g *authGate) noteAudit(r *http.Request, signInID, outcome string) {
	noteAuditDetails(r, signInID, outcome)
}

// safeNext keeps post-sign-in redirects on this origin.
func safeNext(next string) string {
	if next == "" || !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") ||
		strings.ContainsAny(next, "\r\n\\") || strings.HasPrefix(next, "/login") {
		return "/"
	}
	parsed, err := url.Parse(next)
	if err != nil || parsed.Scheme != "" || parsed.Host != "" {
		return "/"
	}
	return next
}

func secretHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func clientIP(r *http.Request) string {
	if info, ok := r.Context().Value(requestSecurityKey{}).(requestSecurity); ok {
		return info.clientIP
	}
	return directClientIP(r.RemoteAddr)
}

func requestIsHTTPS(r *http.Request) bool {
	if info, ok := r.Context().Value(requestSecurityKey{}).(requestSecurity); ok {
		return info.scheme == "https"
	}
	return r.TLS != nil
}

// summarizeUserAgent keeps enough to recognize a device in a list later.
func summarizeUserAgent(agent string) string {
	if len(agent) > 200 {
		agent = agent[:200]
	}
	return agent
}

func formatWait(seconds int) string {
	if seconds < 120 {
		return strconv.Itoa(seconds) + " seconds"
	}
	return strconv.Itoa((seconds+59)/60) + " minutes"
}
