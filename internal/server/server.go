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
	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
	"tessera/web"
)

type Options struct {
	// Addr is the listen address; use "127.0.0.1:0" for an ephemeral port.
	Addr   string
	DBPath string
	// WebDir, when set, serves the SPA from this directory instead of the
	// embedded assets.
	WebDir string
}

type Server struct {
	Addr string // actual bound address, e.g. "127.0.0.1:53211"
	URL  string // "http://" + Addr

	httpServer *http.Server
	store      *store.Store
	runs       *runs.Manager
	terminals  *terminal.Manager
	serveErr   chan error
}

func Start(ctx context.Context, opts Options) (*Server, error) {
	st, err := store.Open(ctx, opts.DBPath)
	if err != nil {
		return nil, fmt.Errorf("open store: %w", err)
	}

	runner := &shell.Runner{}
	runManager := runs.NewManager(st, runner)
	terminalManager := terminal.NewManager()

	var webFS fs.FS = web.Files
	if opts.WebDir != "" {
		webFS = os.DirFS(opts.WebDir)
	}

	application := &app.App{
		Store:     st,
		Runner:    runner,
		Runs:      runManager,
		Terminals: terminalManager,
		WebFS:     webFS,
	}

	ln, err := net.Listen("tcp", opts.Addr)
	if err != nil {
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
