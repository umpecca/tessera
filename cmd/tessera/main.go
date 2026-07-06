package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"tessera/internal/server"
)

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:7331", "address to listen on")
	dbPath := flag.String("db", server.DefaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "", "serve the SPA from this directory instead of embedded assets")
	flag.Parse()

	srv, err := server.Start(context.Background(), server.Options{
		Addr:   *addr,
		DBPath: *dbPath,
		WebDir: *webDir,
	})
	if err != nil {
		log.Fatalf("start server: %v", err)
	}

	log.Printf("Tessera listening at %s", srv.URL)
	log.Printf("SQLite database: %s", *dbPath)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case <-stop:
	case err := <-srv.ServeErr():
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("server failed: %v", err)
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
}
