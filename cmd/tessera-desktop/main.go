package main

import (
	"context"
	"flag"
	"fmt"
	"html"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"tessera/internal/server"
)

func main() {
	log.SetFlags(0)

	addr := flag.String("addr", "127.0.0.1:0", "address for the in-process Tessera server")
	dbPath := flag.String("db", server.DefaultDBPath(), "SQLite database path")
	webDir := flag.String("web", "", "serve the SPA from this directory instead of embedded assets")
	flag.Parse()

	// The GUI subsystem has no console; log next to the database.
	if f, err := openLogFile(*dbPath); err == nil {
		log.SetOutput(f)
		defer f.Close()
	}

	var page http.Handler
	shutdown := func() {}

	srv, err := server.Start(context.Background(), server.Options{
		Addr:   *addr,
		DBPath: *dbPath,
		WebDir: *webDir,
	})
	if err != nil {
		log.Printf("start server: %v", err)
		page = staticPage(errorHTML(err))
	} else {
		log.Printf("Tessera server at %s", srv.URL)
		log.Printf("SQLite database: %s", *dbPath)
		page = staticPage(bootstrapHTML(srv.URL + "/"))
		shutdown = func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := srv.Shutdown(ctx); err != nil {
				log.Printf("server shutdown: %v", err)
			}
		}
	}

	err = wails.Run(&options.App{
		Title:            "Tessera",
		Width:            1280,
		Height:           860,
		MinWidth:         640,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 0xFB, G: 0xFA, B: 0xF6, A: 0xFF}, // board background from web/styles.css
		AssetServer:      &assetserver.Options{Handler: page},
		OnShutdown:       func(ctx context.Context) { shutdown() },
		Windows:          &windows.Options{Theme: windows.SystemDefault},
	})
	if err != nil {
		log.Printf("wails: %v", err)
		shutdown()
		os.Exit(1)
	}
}

func openLogFile(dbPath string) (*os.File, error) {
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return os.OpenFile(filepath.Join(dir, "tessera-desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// bootstrapHTML immediately moves the webview off the Wails asset origin onto
// the in-process server, where streaming responses and WebSocket upgrades
// work; the Wails asset server supports neither.
func bootstrapHTML(target string) string {
	return fmt.Sprintf(`<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=%s">
<style>body{background:#fbfaf6;color:#5f5b52;font:14px system-ui,sans-serif;padding:2rem}</style>
</head><body><p>Starting Tessera…</p>
<script>window.location.replace(%q);</script>
</body></html>`, html.EscapeString(target), target)
}

func errorHTML(err error) string {
	return fmt.Sprintf(`<!doctype html>
<html><head><meta charset="utf-8">
<style>body{background:#fbfaf6;color:#5f5b52;font:14px system-ui,sans-serif;padding:2rem}</style>
</head><body><h1>Tessera failed to start</h1><pre>%s</pre>
</body></html>`, html.EscapeString(err.Error()))
}

func staticPage(content string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write([]byte(content))
	})
}
