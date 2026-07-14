// Package desktop owns the local-server lifecycle used by Tessera's desktop
// notification-area controls.
package desktop

import (
	"context"
	"errors"
	"sync"

	"tessera/internal/server"
)

type startServer func(context.Context, server.Options) (*server.Server, error)
type openBrowser func(string) error

// Controller starts and stops Tessera without terminating the desktop process.
// It is safe for menu callbacks from different goroutines.
type Controller struct {
	mu      sync.Mutex
	opts    server.Options
	start   startServer
	openURL openBrowser
	server  *server.Server
}

func NewController(opts server.Options) *Controller {
	return newController(opts, server.Start, openURL)
}

func newController(opts server.Options, start startServer, open openBrowser) *Controller {
	return &Controller{opts: opts, start: start, openURL: open}
}

// Start starts Tessera if it is stopped. Calling Start while it is already
// running leaves the existing server untouched.
func (c *Controller) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server != nil {
		return nil
	}
	srv, err := c.start(ctx, c.opts)
	if err != nil {
		return err
	}
	c.server = srv
	return nil
}

// Stop cleanly stops the local server while keeping the tray application alive.
func (c *Controller) Stop(ctx context.Context) error {
	c.mu.Lock()
	srv := c.server
	c.server = nil
	c.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

// Configure makes sure the server is running and opens its current workspace
// URL in the user's default browser.
func (c *Controller) Configure(ctx context.Context) error {
	if err := c.Start(ctx); err != nil {
		return err
	}
	c.mu.Lock()
	url := ""
	if c.server != nil {
		url = c.server.URL
	}
	c.mu.Unlock()
	if url == "" {
		return errors.New("Tessera server is not running")
	}
	return c.openURL(url)
}

func (c *Controller) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.server != nil
}

func (c *Controller) URL() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.server == nil {
		return ""
	}
	return c.server.URL
}
