package main

import (
	"context"
	"flag"
	"fmt"
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
	audioCaptureHelper := flag.String("audio-capture-helper", "", "process-audio capture helper path (defaults to the executable directory or PATH)")
	audioEncoder := flag.String("audio-encoder", "", "LAME-compatible encoder path (defaults to the bundled sidecar or PATH)")
	var trustedProxies stringListFlag
	flag.Var(&trustedProxies, "trusted-proxy", "trusted immediate proxy IP or CIDR; repeat or use a comma-separated list")
	rateLimit := flag.Int("rate-limit", 600, "maximum API requests per client per minute; negative disables")
	rateBurst := flag.Int("rate-burst", 120, "maximum per-client API request burst; negative disables")
	auditLog := flag.Bool("audit-log", false, "persist redacted security audit events")
	auditRetention := flag.Int("audit-retention-days", 30, "audit-event retention in days when -audit-log is enabled; negative disables")
	maxUploadSize := flag.Int64("max-upload-size", server.DefaultMaxUploadBytes, "maximum bytes per File Browser upload")
	systemdUpdate := flag.Bool("systemd-update", false, "apply an update and restart tessera.service (root transient-unit helper)")
	flag.Parse()

	if *systemdUpdate {
		if err := update.RunSystemdServiceUpdate(context.Background(), updateRepo); err != nil {
			log.Fatalf("systemd update: %v", err)
		}
		log.Printf("systemd update complete")
		return
	}

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
		Addr:               *addr,
		DBPath:             *dbPath,
		WebDir:             *webDir,
		Users:              users,
		Updater:            updater,
		AudioCaptureHelper: *audioCaptureHelper,
		AudioEncoder:       *audioEncoder,
		TrustedProxies:     trustedProxies,
		RateLimitPerMinute: *rateLimit,
		RateLimitBurst:     *rateBurst,
		AuditEnabled:       *auditLog,
		AuditRetentionDays: *auditRetention,
		MaxUploadBytes:     *maxUploadSize,
	})
	if err := controller.Start(context.Background()); err != nil {
		if signalErr := update.SignalReplacementFailure(err); signalErr != nil {
			log.Printf("signal update restart failure: %v", signalErr)
		}
		log.Fatalf("start server: %v", err)
	}
	if err := update.SignalReplacementReady(); err != nil {
		log.Printf("signal update restart readiness: %v", err)
	}

	log.Printf("Tessera listening at %s", controller.URL())
	log.Printf("SQLite database: %s", *dbPath)
	if len(users) > 0 {
		log.Printf("Multi-user mode: %s", strings.Join(users, ", "))
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	exitTray := make(chan struct{}, 1)
	shutdown := make(chan struct{}, 1)
	var restartCh <-chan struct{}
	if updater != nil {
		restartCh = updater.RestartRequested()
	}

	go func() {
		for {
			select {
			case <-stop:
				shutdown <- struct{}{}
				if useTray {
					desktop.QuitTray()
				}
				return
			case <-restartCh:
				log.Printf("restarting for update")
				// The macOS tray loop runs on the main thread and is not a
				// reliable prerequisite for lifecycle progress: systray.Quit
				// can remove the tray item without returning from RunTray.
				// Complete the handoff here, then terminate the stopped host.
				if err := restartUpdatedServer(controller.Stop, controller.Start, updater.SpawnReplacement); err != nil {
					log.Printf("restart updated executable: %v", err)
					restartCh = nil
					continue
				}
				log.Printf("updated server reported ready")
				os.Exit(0)
			case <-exitTray:
				shutdown <- struct{}{}
				if useTray {
					desktop.QuitTray()
				}
				return
			}
		}
	}()

	if useTray {
		var trayUpdate func(context.Context) (bool, error)
		if updater != nil {
			trayUpdate = newTrayUpdateAction(updater)
		}
		desktop.RunTray(controller, trayUpdate, func() { exitTray <- struct{}{} })
	}
	<-shutdown

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := controller.Stop(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
}

type trayUpdater interface {
	Apply(context.Context) (*update.CheckResult, error)
	RequestRestart()
}

func newTrayUpdateAction(updater trayUpdater) func(context.Context) (bool, error) {
	return func(ctx context.Context) (bool, error) {
		result, err := updater.Apply(ctx)
		if err != nil {
			return false, err
		}
		if !result.UpdateAvailable {
			return false, nil
		}
		updater.RequestRestart()
		return true, nil
	}
}

func restartUpdatedServer(
	stopServer func(context.Context) error,
	startServer func(context.Context) error,
	spawnReplacement func() error,
) error {
	log.Printf("stopping server for update")
	stopCtx, cancelStop := context.WithTimeout(context.Background(), 5*time.Second)
	stopErr := stopServer(stopCtx)
	cancelStop()
	if stopErr == nil {
		log.Printf("server stopped for update")
		log.Printf("starting updated executable")
		if err := spawnReplacement(); err == nil {
			return nil
		} else {
			stopErr = fmt.Errorf("start replacement: %w", err)
		}
	} else {
		stopErr = fmt.Errorf("stop current server: %w", stopErr)
	}

	// The executable has already been installed, but this process still has the
	// previous image in memory. Bring its server back if handoff fails so the
	// browser is not left permanently offline and the failure remains visible.
	recoveryCtx, cancelRecovery := context.WithTimeout(context.Background(), 5*time.Second)
	recoveryErr := startServer(recoveryCtx)
	cancelRecovery()
	if recoveryErr != nil {
		return fmt.Errorf("%v; restore current server: %w", stopErr, recoveryErr)
	}
	return fmt.Errorf("%v; current server restored", stopErr)
}

type stringListFlag []string

func (f *stringListFlag) String() string {
	return strings.Join(*f, ",")
}

func (f *stringListFlag) Set(value string) error {
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			*f = append(*f, part)
		}
	}
	return nil
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
