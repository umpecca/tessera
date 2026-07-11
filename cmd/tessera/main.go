package main

import (
	"context"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tessera/internal/server"
	"tessera/internal/update"
)

// updateRepo is the GitHub repository the self-updater checks for releases.
const updateRepo = "bently0602/tessera"

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:7331", "address to listen on")
	dbPath := flag.String("db", server.DefaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "", "serve the SPA from this directory instead of embedded assets")
	usersFlag := flag.String("users", "", "comma-separated user roster; enables the user selection screen and a separate workspace per user")
	flag.Parse()

	users := parseUsers(*usersFlag)

	updater, err := update.New(updateRepo)
	if err != nil {
		log.Printf("self-update unavailable: %v", err)
	} else {
		updater.CleanupOld()
	}

	srv, err := server.Start(context.Background(), server.Options{
		Addr:    *addr,
		DBPath:  *dbPath,
		WebDir:  *webDir,
		Users:   users,
		Updater: updater,
	})
	if err != nil {
		log.Fatalf("start server: %v", err)
	}

	log.Printf("Tessera listening at %s", srv.URL)
	log.Printf("SQLite database: %s", *dbPath)
	if len(users) > 0 {
		log.Printf("Multi-user mode: %s", strings.Join(users, ", "))
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	restart := false
	var restartCh <-chan struct{}
	if updater != nil {
		restartCh = updater.RestartRequested()
	}

	select {
	case <-stop:
	case <-restartCh:
		restart = true
		log.Printf("restarting for update")
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

	if restart {
		if err := updater.SpawnReplacement(); err != nil {
			log.Fatalf("spawn updated executable: %v", err)
		}
	}
}

// parseUsers splits the -users flag into a trimmed, de-duplicated roster,
// preserving the order they were given.
func parseUsers(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	seen := make(map[string]bool)
	var users []string
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		users = append(users, name)
	}
	return users
}
