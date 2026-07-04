package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"tessera/internal/app"
	"tessera/internal/runs"
	"tessera/internal/shell"
	"tessera/internal/store"
	"tessera/internal/terminal"
)

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:7331", "address to listen on")
	dbPath := flag.String("db", defaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "web", "directory containing the SPA files")
	flag.Parse()

	ctx := context.Background()
	st, err := store.Open(ctx, *dbPath)
	if err != nil {
		log.Fatalf("open store: %v", err)
	}
	defer st.Close()

	runner := &shell.Runner{}
	runManager := runs.NewManager(st, runner)
	defer runManager.Close()
	terminalManager := terminal.NewManager()
	defer terminalManager.Close()

	application := &app.App{
		Store:     st,
		Runner:    runner,
		Runs:      runManager,
		Terminals: terminalManager,
		WebDir:    *webDir,
	}

	server := &http.Server{
		Addr:              *addr,
		Handler:           application.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		log.Printf("Tessera listening at http://%s", *addr)
		log.Printf("SQLite database: %s", *dbPath)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
}

func defaultDBPath() string {
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
