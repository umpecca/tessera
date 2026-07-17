// Package server wires Tessera's storage, managers, and HTTP API into a
// runnable localhost server shared by the web and desktop entry points.
package server

import (
	"context"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"tessera/internal/app"
	"tessera/internal/audio"
	"tessera/internal/httpapi"
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
}

const DefaultMaxUploadBytes int64 = httpapi.DefaultMaxUploadBytes

type Server struct {
	Addr string // actual bound address, e.g. "127.0.0.1:53211"
	URL  string // "http://" + Addr

	httpServer *http.Server
	store      *store.Store
	runs       *runs.Manager
	terminals  *terminal.Manager
	audio      *audio.Manager
	serveErr   chan error
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
	}

	ln, err := net.Listen("tcp", opts.Addr)
	if err != nil {
		audioManager.Close()
		terminalManager.Close()
		runManager.Close()
		_ = st.Close()
		return nil, fmt.Errorf("listen %s: %w", opts.Addr, err)
	}

	srv := &Server{
		Addr: ln.Addr().String(),
		httpServer: &http.Server{
			Handler:           application.Handler(),
			ReadHeaderTimeout: 5 * time.Second,
		},
		store:     st,
		runs:      runManager,
		terminals: terminalManager,
		audio:     audioManager,
		serveErr:  make(chan error, 1),
	}
	srv.URL = "http://" + srv.Addr

	go func() {
		srv.serveErr <- srv.httpServer.Serve(ln)
	}()
	return srv, nil
}

// ServeErr receives the result of the underlying http.Server once it stops
// serving; http.ErrServerClosed follows a clean Shutdown.
func (s *Server) ServeErr() <-chan error {
	return s.serveErr
}

// Shutdown stops the HTTP server, then closes managers and storage in the
// reverse of their startup order.
func (s *Server) Shutdown(ctx context.Context) error {
	err := s.httpServer.Shutdown(ctx)
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
