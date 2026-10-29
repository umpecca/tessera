// Package server wires Tessera's storage, managers, and HTTP API into a
// runnable localhost server.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tessera/internal/app"
	"tessera/internal/auth"
	"tessera/internal/httpapi"
	"tessera/internal/localhttps"
	"tessera/internal/rdpsession"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/internal/update"
	"tessera/web"
)

type Options struct {
	// Addr is the listen address; use "127.0.0.1:0" for an ephemeral port.
	Addr   string
	DBPath string
	// WebDir, when set, serves the SPA from this directory instead of the
	// embedded assets.
	WebDir string
	// Users, when non-empty, enables multi-user mode: the SPA shows a user
	// selection screen and each user gets a separate workspace.
	Users []string
	// Updater, when set, enables the /api/update self-update endpoint.
	Updater *update.Updater
	// TrustedProxies contains exact IP addresses or CIDR ranges for immediate
	// peers whose Forwarded or X-Forwarded-* headers Tessera may use.
	TrustedProxies []string
	// AllowedHosts are DNS names, beyond the machine's own, that requests may
	// use as their Host. IP addresses are always accepted.
	AllowedHosts []string
	// RateLimitPerMinute and RateLimitBurst control the per-client in-memory API
	// limiter. Negative values disable it; zero selects the server defaults.
	RateLimitPerMinute int
	RateLimitBurst     int
	// AuditEnabled opts into persistent security-event logging. Retention is
	// ignored while it is false. Negative retention disables persistence and
	// zero selects the server default.
	AuditEnabled       bool
	AuditRetentionDays int
	// MaxUploadBytes limits one terminal file upload; zero selects the 1 GiB
	// default.
	MaxUploadBytes int64
	// RDPIdleLimit is how long a kept RDP session lasts with no browser
	// attached; zero selects rdpsession.DefaultIdleLimit.
	RDPIdleLimit time.Duration
	// PKIDir is where Local HTTPS keys were kept before they moved into the
	// database, beside DBPath unless set. They are imported once.
	PKIDir         string
	RequestRestart func(localhttps.Config)
	// Auth configures sign-in; the zero value leaves it off.
	Auth httpapi.AuthOptions
	// AccountsFile is the credentials file accounts were kept in before
	// they moved into the database. Its accounts are imported once.
	AccountsFile string
}

const DefaultMaxUploadBytes int64 = httpapi.DefaultMaxUploadBytes

type Server struct {
	Addr      string // actual HTTP address, e.g. "127.0.0.1:53211"
	URL       string // "http://" + Addr
	HTTPSAddr string // actual HTTPS address when Local HTTPS is enabled
	HTTPSURL  string

	httpServer     *http.Server
	httpsServer    *http.Server
	listenerMu     sync.Mutex
	handler        http.Handler
	defaultAddress string
	store          *store.Store
	terminals      *terminal.Manager
	rdpSessions    *rdpsession.Manager
	serveErr       chan error
}

func Start(ctx context.Context, opts Options) (*Server, error) {
	trustedProxies, err := httpapi.ParseTrustedProxies(opts.TrustedProxies)
	if err != nil {
		return nil, err
	}
	ratePerMinute := opts.RateLimitPerMinute
	if ratePerMinute == 0 {
		ratePerMinute = 600
	}
	rateBurst := opts.RateLimitBurst
	if rateBurst == 0 {
		rateBurst = 120
	}
	if ratePerMinute < 0 || rateBurst < 0 {
		ratePerMinute, rateBurst = 0, 0
	}
	auditRetentionDays := opts.AuditRetentionDays
	if auditRetentionDays == 0 {
		auditRetentionDays = 30
	}
	var auditRetention time.Duration
	if opts.AuditEnabled && auditRetentionDays > 0 {
		auditRetention = time.Duration(auditRetentionDays) * 24 * time.Hour
	}
	maxUploadBytes := opts.MaxUploadBytes
	if maxUploadBytes <= 0 {
		maxUploadBytes = DefaultMaxUploadBytes
	}

	st, err := store.Open(ctx, opts.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}
	httpsConfig, err := st.LoadLocalHTTPSConfig(ctx, opts.Addr)
	if err != nil {
		_ = st.Close()
		return nil, err
	}
	ImportAccountsFile(ctx, st, opts.AccountsFile)
	if err := resolveSignIn(ctx, st, &opts.Auth); err != nil {
		_ = st.Close()
		return nil, err
	}
	pkiDir := opts.PKIDir
	if pkiDir == "" {
		pkiDir = filepath.Join(filepath.Dir(opts.DBPath), "pki")
	}
	if imported, err := localhttps.Import(localhttps.Dir(pkiDir), st.PKIFiles()); err != nil {
		log.Printf("Local HTTPS keys in %s were not imported: %v", pkiDir, err)
	} else if imported {
		log.Printf("Imported the Local HTTPS keys from %s, which is no longer used and can be deleted", pkiDir)
	}
	// RDP sessions kept on the host (task 238); the module compiles on the
	// first one, and its compiled code is cached beside the database.
	rdpIdleLimit := opts.RDPIdleLimit
	if rdpIdleLimit <= 0 {
		rdpIdleLimit = rdpsession.DefaultIdleLimit
	}
	rdpSessions := rdpsession.NewManager(filepath.Join(filepath.Dir(opts.DBPath), "rdp-module-cache"), rdpIdleLimit)
	terminalManager := terminal.NewManager()
	terminalManager.Files.SetMaxUpload(maxUploadBytes)
	var webFS fs.FS = web.Files
	if opts.WebDir != "" {
		webFS = os.DirFS(opts.WebDir)
	}

	application := &app.App{
		Store:          st,
		Terminals:      terminalManager,
		WebFS:          webFS,
		Users:          opts.Users,
		Updater:        opts.Updater,
		MaxUploadBytes: maxUploadBytes,
		Auth:           opts.Auth,
		Security: httpapi.SecurityOptions{
			TrustedProxies: trustedProxies,
			AllowedHosts:   opts.AllowedHosts,
			DefaultAddress: opts.Addr,
			RatePerMinute:  ratePerMinute,
			RateBurst:      rateBurst,
			AuditEnabled:   opts.AuditEnabled,
			AuditRetention: auditRetention,
		},
		HTTPSDefaultAddress: opts.Addr,
		RequestRestart:      opts.RequestRestart,
		RDPSessions:         rdpSessions,
	}

	srv := &Server{
		handler:        application.Handler(),
		defaultAddress: opts.Addr,
		store:          st,
		terminals:      terminalManager,
		rdpSessions:    rdpSessions,
		serveErr:       make(chan error, 1),
	}
	if err := srv.startListeners(httpsConfig); err != nil {
		terminalManager.Close()
		_ = st.Close()
		return nil, err
	}
	return srv, nil
}

func (s *Server) startListeners(config localhttps.Config) error {
	s.listenerMu.Lock()
	defer s.listenerMu.Unlock()
	return s.startListenersLocked(config)
}

func (s *Server) startListenersLocked(config localhttps.Config) error {
	httpListener, err := listenTCP("Tessera HTTP", s.defaultAddress)
	if err != nil {
		return err
	}
	httpAddress := httpListener.Addr().String()
	httpURL := "http://" + httpAddress

	var httpsListener net.Listener
	var httpsAddress, httpsURL string
	if config.Enabled {
		config, err = localhttps.NormalizeConfig(config)
		if err != nil {
			_ = httpListener.Close()
			return fmt.Errorf("local HTTPS settings: %w", err)
		}
		if err := localhttps.ValidateSeparateListeners(config, s.defaultAddress); err != nil {
			_ = httpListener.Close()
			return fmt.Errorf("local HTTPS settings: %w", err)
		}
		material, ensureErr := localhttps.Ensure(s.store.PKIFiles(), config)
		if ensureErr != nil {
			_ = httpListener.Close()
			return fmt.Errorf("prepare local HTTPS: %w", ensureErr)
		}
		httpsListener, err = listenTCP("Tessera HTTPS", config.HTTPSAddress)
		if err != nil {
			_ = httpListener.Close()
			return err
		}
		httpsAddress = httpsListener.Addr().String()
		httpsURL = localhttps.PublicURL(config, httpsAddress)
		httpsListener = tls.NewListener(httpsListener, &tls.Config{
			Certificates: []tls.Certificate{material.Certificate},
			MinVersion:   tls.VersionTLS12,
		})
	}

	httpServer := &http.Server{Handler: s.handler, ReadHeaderTimeout: 5 * time.Second}
	var httpsServer *http.Server
	if httpsListener != nil {
		httpsServer = &http.Server{Handler: s.handler, ReadHeaderTimeout: 5 * time.Second}
	}
	s.Addr = httpAddress
	s.URL = httpURL
	s.HTTPSAddr = httpsAddress
	s.HTTPSURL = httpsURL
	s.httpServer = httpServer
	s.httpsServer = httpsServer
	s.serve(httpServer, httpListener)
	if httpsServer != nil {
		s.serve(httpsServer, httpsListener)
	}
	return nil
}

func (s *Server) serve(server *http.Server, listener net.Listener) {
	go func() {
		serveErr := server.Serve(listener)
		if errors.Is(serveErr, http.ErrServerClosed) {
			return
		}
		select {
		case s.serveErr <- serveErr:
		default:
		}
	}()
}

// ReloadLocalHTTPS replaces only Tessera's network listeners. The store,
// terminal manager, and native PTYs stay alive so changing transport settings
// cannot tear down active Windows ConPTY sessions.
func (s *Server) ReloadLocalHTTPS(ctx context.Context) error {
	config, err := s.store.LoadLocalHTTPSConfig(ctx, s.defaultAddress)
	if err != nil {
		return err
	}
	s.listenerMu.Lock()
	defer s.listenerMu.Unlock()
	if err := s.shutdownListenersLocked(ctx); err != nil {
		return err
	}
	return s.startListenersLocked(config)
}

func (s *Server) shutdownListenersLocked(ctx context.Context) error {
	var result error
	if s.httpServer != nil {
		result = s.httpServer.Shutdown(ctx)
		s.httpServer = nil
	}
	if s.httpsServer != nil {
		if err := s.httpsServer.Shutdown(ctx); err != nil && result == nil {
			result = err
		}
		s.httpsServer = nil
	}
	s.HTTPSAddr = ""
	s.HTTPSURL = ""
	return result
}

func listenTCP(serviceName, address string) (net.Listener, error) {
	listener, err := net.Listen("tcp", address)
	if err == nil {
		return listener, nil
	}
	if isAddressInUse(err) {
		_, port, splitErr := net.SplitHostPort(address)
		if splitErr != nil || port == "" {
			port = address
		}
		return nil, fmt.Errorf("port conflict: %s cannot listen on port %s because it is already in use; stop the other Tessera instance or choose a different port", serviceName, port)
	}
	return nil, fmt.Errorf("listen on %s: %w", address, err)
}

// ServeErr receives unexpected failures from the active HTTP server. Clean
// listener reloads and shutdowns are not reported as failures.
func (s *Server) ServeErr() <-chan error {
	return s.serveErr
}

// Shutdown stops the HTTP server, then closes managers and storage in the
// reverse of their startup order.
func (s *Server) Shutdown(ctx context.Context) error {
	s.listenerMu.Lock()
	err := s.shutdownListenersLocked(ctx)
	s.listenerMu.Unlock()
	s.terminals.Close()
	s.rdpSessions.Shutdown(ctx)
	if closeErr := s.store.Close(); closeErr != nil && err == nil {
		err = closeErr
	}
	return err
}

func DefaultDBPath() string {
	configDir, err := os.UserConfigDir()
	if err == nil && configDir != "" {
		return filepath.Join(configDir, "Tessera", "tessera.sqlite3")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "tessera.sqlite3"
	}
	return filepath.Join(cwd, "tessera.sqlite3")
}

// ImportAccountsFile moves the accounts of a credentials file from before
// accounts were kept in the database into it, once. The file is left alone.
func ImportAccountsFile(ctx context.Context, st *store.Store, path string) {
	if path == "" {
		return
	}
	accounts, err := auth.ReadCredentialsFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		log.Printf("accounts in %s were not imported: %v", path, err)
		return
	}
	imported, err := st.ImportAccounts(ctx, accounts)
	if err != nil {
		log.Printf("accounts in %s were not imported: %v", path, err)
	} else if imported {
		log.Printf("Imported %d accounts from %s, which is no longer used and can be deleted", len(accounts), path)
	}
}

// resolveSignIn picks the sign-in mode: -auth when given, which is also
// saved so it lasts once the flag is dropped, otherwise the one chosen in
// Settings. A mode that can never work stops the server rather than leaving
// it open; unusable accounts only stop anyone signing in until they're fixed.
func resolveSignIn(ctx context.Context, st *store.Store, options *httpapi.AuthOptions) error {
	if options.Mode == "" {
		mode, err := st.LoadSignInMode(ctx)
		if err != nil {
			return err
		}
		if mode == "" {
			mode = httpapi.AuthOff
		}
		if err := options.CheckMode(mode); err != nil {
			return fmt.Errorf("sign-in is set to %s in Settings, but %w; start with -auth=off to turn it off", mode, err)
		}
		options.Mode = mode
	} else if err := st.SaveSignInMode(ctx, options.Mode); err != nil {
		return err
	}
	switch options.Mode {
	case httpapi.AuthFile:
		log.Printf("Sign-in required with a Tessera account")
		if err := httpapi.AccountsProblem(ctx, st); err != nil {
			log.Printf("Nobody can sign in until this is fixed: %v", err)
		}
	case httpapi.AuthSystem:
		log.Printf("Sign-in required with the password of %s", options.SystemAccount)
	}
	return nil
}
