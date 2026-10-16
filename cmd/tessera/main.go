package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tessera/internal/auth"
	"tessera/internal/desktop"
	"tessera/internal/httpapi"
	"tessera/internal/localhttps"
	"tessera/internal/server"
	"tessera/internal/store"
	"tessera/internal/sysauth"
	"tessera/internal/update"
)

// updateRepo is the GitHub repository the self-updater checks for releases.
const updateRepo = "umpecca/tessera"

func main() {
	log.SetFlags(0)
	if len(os.Args) > 1 {
		var err error
		switch os.Args[1] {
		case "user":
			err = runUserCommand(os.Args[2:], os.Stdin, os.Stdout, os.Stderr, terminalPasswordReader())
		case "login":
			err = runLoginCommand(os.Args[2:], os.Stdout, os.Stderr)
		case "logout":
			err = runLogoutCommand(os.Args[2:], os.Stdout, os.Stderr)
		default:
			goto serve
		}
		if err != nil {
			log.Fatalf("tessera %s: %v", os.Args[1], err)
		}
		return
	}
serve:

	addr := flag.String("addr", "127.0.0.1:7331", "address to listen on")
	dbPath := flag.String("db", server.DefaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "", "serve the SPA from this directory instead of embedded assets")
	usersFlag := flag.String("users", "", "comma-separated user roster; enables the user selection screen and a separate workspace per user")
	tray := flag.Bool("tray", desktop.TraySupported(), "show Start, Stop, Configure, and Exit controls in the system tray")
	var trustedProxies stringListFlag
	var allowedHosts stringListFlag
	flag.Var(&allowedHosts, "allowed-host", "extra DNS name Tessera answers to, such as a Tailscale or reverse-proxy name; repeat or use a comma-separated list")
	flag.Var(&trustedProxies, "trusted-proxy", "trusted immediate proxy IP or CIDR; repeat or use a comma-separated list")
	rateLimit := flag.Int("rate-limit", 600, "maximum API requests per client per minute; negative disables")
	rateBurst := flag.Int("rate-burst", 120, "maximum per-client API request burst; negative disables")
	auditLog := flag.Bool("audit-log", false, "persist redacted security audit events")
	auditRetention := flag.Int("audit-retention-days", 30, "audit-event retention in days when -audit-log is enabled; negative disables")
	maxUploadSize := flag.Int64("max-upload-size", server.DefaultMaxUploadBytes, "maximum bytes per terminal file upload")
	authMode := flag.String("auth", httpapi.AuthOff, "sign-in: off, system (this host account's password), or file (accounts managed with `tessera user`)")
	authToken := flag.String("auth-token", auth.DefaultTokenPath(), "host recovery token for `tessera login` and `tessera logout`")
	authFile := flag.String("auth-file", auth.DefaultCredentialsPath(), "credentials file for -auth=file")
	allowHTTPSignIn := flag.Bool("allow-http-sign-in", false, "accept passwords over plain HTTP from other devices; only for already-encrypted links such as Tailscale or a VPN")
	signInIdle := flag.Duration("signin-idle", httpapi.DefaultRememberIdle, "how long a remembered sign-in lasts without use")
	signInMax := flag.Duration("signin-max", httpapi.DefaultRememberMax, "longest a remembered sign-in lasts")
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
	authOptions, err := authOptionsFromFlags(*authMode, *authFile, users, *allowHTTPSignIn, *signInIdle, *signInMax)
	if err != nil {
		log.Fatalf("%v", err)
	}
	if authOptions.Mode != httpapi.AuthOff {
		if _, err := auth.EnsureToken(*authToken); err != nil {
			log.Printf("host recovery token unavailable, so `tessera login` will not work: %v", err)
		} else {
			authOptions.TokenPath = *authToken
		}
	}
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
	localRestart := make(chan localhttps.Config, 1)
	requestLocalRestart := func(previous localhttps.Config) {
		select {
		case localRestart <- previous:
		default:
		}
	}

	controller := desktop.NewController(server.Options{
		Addr:               *addr,
		DBPath:             *dbPath,
		WebDir:             *webDir,
		Users:              users,
		Updater:            updater,
		TrustedProxies:     trustedProxies,
		AllowedHosts:       allowedHosts,
		RateLimitPerMinute: *rateLimit,
		RateLimitBurst:     *rateBurst,
		AuditEnabled:       *auditLog,
		AuditRetentionDays: *auditRetention,
		MaxUploadBytes:     *maxUploadSize,
		RequestRestart:     requestLocalRestart,
		Auth:               authOptions,
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
	switch authOptions.Mode {
	case httpapi.AuthFile:
		log.Printf("Sign-in required; accounts from %s", *authFile)
	case httpapi.AuthSystem:
		log.Printf("Sign-in required with the password of %s", authOptions.SystemAccount)
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
			case previousConfig := <-localRestart:
				log.Printf("reloading listeners to apply Local HTTPS settings")
				restartCtx, cancelRestart := context.WithTimeout(context.Background(), 10*time.Second)
				reloadErr := controller.ReloadLocalHTTPS(restartCtx)
				cancelRestart()
				if reloadErr != nil {
					log.Printf("reload Local HTTPS listeners: %v", reloadErr)
					rollbackStore, rollbackErr := store.Open(context.Background(), *dbPath)
					if rollbackErr == nil {
						rollbackErr = rollbackStore.SaveLocalHTTPSConfig(context.Background(), previousConfig)
						if closeErr := rollbackStore.Close(); closeErr != nil {
							log.Printf("close Local HTTPS rollback store: %v", closeErr)
						}
					}
					if rollbackErr != nil {
						log.Printf("restore previous Local HTTPS settings: %v", rollbackErr)
						continue
					}
					if recoveryErr := controller.ReloadLocalHTTPS(context.Background()); recoveryErr != nil {
						log.Printf("reload previous Local HTTPS listeners: %v", recoveryErr)
						continue
					}
					log.Printf("restored previous Local HTTPS settings at %s", controller.URL())
					continue
				}
				log.Printf("Tessera listening at %s", controller.URL())
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

// authOptionsFromFlags validates the sign-in flags. With -auth=file the
// accounts are the users, so -users would be a second, conflicting roster.
func authOptionsFromFlags(mode, file string, users []string, allowHTTP bool, idle, maxAge time.Duration) (httpapi.AuthOptions, error) {
	options := httpapi.AuthOptions{Mode: mode, AllowHTTPSignIn: allowHTTP, RememberIdle: idle, RememberMax: maxAge}
	switch mode {
	case httpapi.AuthOff:
		return options, nil
	case httpapi.AuthFile:
	case httpapi.AuthSystem:
		if idle <= 0 || maxAge <= 0 {
			return options, errors.New("-signin-idle and -signin-max must be positive")
		}
		account, err := sysauth.Account()
		if err != nil {
			return options, fmt.Errorf("find the account Tessera runs as: %w", err)
		}
		options.SystemAccount = account
		options.VerifySystem = func(ctx context.Context, password []byte) error {
			err := sysauth.Verify(ctx, account, password)
			if errors.Is(err, sysauth.ErrUnavailable) {
				// The reason names a helper or system call, never the password.
				log.Printf("system sign-in unavailable: %v", err)
				return httpapi.ErrSystemAuthUnavailable
			}
			return err
		}
		return options, nil
	default:
		return options, fmt.Errorf("-auth must be off, system or file, not %q", mode)
	}
	if len(users) > 0 {
		return options, errors.New("-users cannot be combined with -auth=file: each account in the credentials file is a user")
	}
	if idle <= 0 || maxAge <= 0 {
		return options, errors.New("-signin-idle and -signin-max must be positive")
	}
	accounts, err := auth.ReadCredentialsFile(file)
	if errors.Is(err, os.ErrNotExist) || (err == nil && len(accounts) == 0) {
		return options, fmt.Errorf("-auth=file needs at least one account in %s; create one with: tessera user add <name>", file)
	}
	if err != nil {
		return options, fmt.Errorf("read credentials: %w", err)
	}
	options.Credentials = auth.NewCredentials(file)
	return options, nil
}
