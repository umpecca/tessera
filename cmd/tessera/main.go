package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tessera/internal/desktop"
	"tessera/internal/server"
	"tessera/internal/update"
)

// updateRepo is the GitHub repository the self-updater checks for releases.
const updateRepo = "umpecca/tessera"

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:7331", "address to listen on")
	dbPath := flag.String("db", server.DefaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "", "serve the SPA from this directory instead of embedded assets")
	usersFlag := flag.String("users", "", "comma-separated user roster; enables the user selection screen and a separate workspace per user")
	tray := flag.Bool("tray", desktop.TraySupported(), "show Start, Stop, Configure, and Exit controls in the system tray")
	flag.Parse()

	users := parseUsers(*usersFlag)
	useTray := *tray && desktop.TraySupported()
	if *tray && !desktop.TraySupported() {
		log.Printf("system tray is not supported on this platform; continuing without it")
	}

	updater, err := update.New(updateRepo)
	if err != nil {
		log.Printf("self-update unavailable: %v", err)
	} else {
		updater.CleanupOld()
	}

	controller := desktop.NewController(server.Options{
		Addr:    *addr,
		DBPath:  *dbPath,
		WebDir:  *webDir,
		Users:   users,
		Updater: updater,
	})
	if err := controller.Start(context.Background()); err != nil {
		log.Fatalf("start server: %v", err)
	}

	log.Printf("Tessera listening at %s", controller.URL())
	log.Printf("SQLite database: %s", *dbPath)
	if len(users) > 0 {
		log.Printf("Multi-user mode: %s", strings.Join(users, ", "))
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	exitTray := make(chan struct{}, 1)
	type shutdownReason bool
	const restartForUpdate shutdownReason = true
	shutdown := make(chan shutdownReason, 1)
	var restartCh <-chan struct{}
	if updater != nil {
		restartCh = updater.RestartRequested()
	}

	go func() {
		select {
		case <-stop:
			shutdown <- false
		case <-restartCh:
			log.Printf("restarting for update")
			shutdown <- restartForUpdate
		case <-exitTray:
			shutdown <- false
		}
		if useTray {
			desktop.QuitTray()
		}
	}()

	if useTray {
		desktop.RunTray(controller, func() { exitTray <- struct{}{} })
	}
	restart := <-shutdown

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := controller.Stop(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}

	if bool(restart) {
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
