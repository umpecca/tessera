// Package server wires Tessera's storage, managers, and HTTP API into a
// runnable localhost server shared by the web and desktop entry points.
package server

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tessera/internal/app"
	"tessera/internal/audio"
	"tessera/internal/httpapi"
	"tessera/internal/localhttps"
	"tessera/internal/runs"
	"tessera/internal/shell"
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
	Updater            *update.Updater
	AudioCaptureHelper string
	AudioEncoder       string
	// TrustedProxies contains exact IP addresses or CIDR ranges for immediate
	// peers whose Forwarded or X-Forwarded-* headers Tessera may use.
	TrustedProxies []string
	// RateLimitPerMinute and RateLimitBurst control the per-client in-memory API
	// limiter. Negative values disable it; zero selects the server defaults.
	RateLimitPerMinute int
	RateLimitBurst     int
	// AuditEnabled opts into persistent security-event logging. Retention is
	// ignored while it is false. Negative retention disables persistence and
	// zero selects the server default.
	AuditEnabled       bool
	AuditRetentionDays int
	// MaxUploadBytes limits one File Browser upload; zero selects the 1 GiB
	// default.
	MaxUploadBytes int64
	// PKIDir overrides the directory beside DBPath used for Local HTTPS keys.
	// It is primarily useful for tests and portable deployments.
	PKIDir         string
	RequestRestart func(localhttps.Config)
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
	pkiDir         string
	store          *store.Store
	runs           *runs.Manager
	terminals      *terminal.Manager
	audio          *audio.Manager
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
	pkiDir := opts.PKIDir
	if pkiDir == "" {
		pkiDir = filepath.Join(filepath.Dir(opts.DBPath), "pki")
	}
	runner := &shell.Runner{}
	runManager := runs.NewManager(st, runner)
	terminalManager := terminal.NewManager()
	audioManager := audio.NewManager(st, terminalManager, audio.Options{
		CaptureHelper: opts.AudioCaptureHelper,
		Encoder:       opts.AudioEncoder,
		EnsureEncoder: func(ctx context.Context) error {
			if opts.Updater == nil {
				return fmt.Errorf("self-updater is unavailable")
			}
			return opts.Updater.EnsureCompanion(ctx)
		},
	})
	if opts.Updater != nil {
		opts.Updater.SetBeforeInstall(audioManager.StopForUpdate)
	}

	var webFS fs.FS = web.Files
	if opts.WebDir != "" {
		webFS = os.DirFS(opts.WebDir)
	}

	application := &app.App{
		Store:          st,
		Runner:         runner,
		Runs:           runManager,
		Terminals:      terminalManager,
		Audio:          audioManager,
		WebFS:          webFS,
		Users:          opts.Users,
		Updater:        opts.Updater,
		MaxUploadBytes: maxUploadBytes,
		Security: httpapi.SecurityOptions{
			TrustedProxies: trustedProxies,
			RatePerMinute:  ratePerMinute,
			RateBurst:      rateBurst,
			AuditEnabled:   opts.AuditEnabled,
			AuditRetention: auditRetention,
		},
		HTTPSDefaultAddress: opts.Addr,
		HTTPSPKIDir:         pkiDir,
		RequestRestart:      opts.RequestRestart,
	}

	srv := &Server{
		handler:        application.Handler(),
		defaultAddress: opts.Addr,
		pkiDir:         pkiDir,
		store:          st,
		runs:           runManager,
		terminals:      terminalManager,
		audio:          audioManager,
		serveErr:       make(chan error, 1),
	}
	if err := srv.startListeners(httpsConfig); err != nil {
		audioManager.Close()
		terminalManager.Close()
		runManager.Close()
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
		material, ensureErr := localhttps.Ensure(s.pkiDir, config)
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
	s.audio.Close()
	s.terminals.Close()
	s.runs.Close()
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
