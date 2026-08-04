// Package web embeds the Tessera SPA assets served at the web root.
package web

import "embed"

// Files holds the SPA files served by both the web server and the desktop
// app. Build inputs (codemirror-entry.js, terminal-entry.js, and the terminal
// render scheduler) are excluded; run `npm run build:web` before `go build`
// when the vendor bundles change.
//
//go:embed index.html manifest.webmanifest app.js styles.css browser-pane.mjs pane-activation.mjs text-editor-language.mjs server-connection.mjs server-update.mjs terminal-font.mjs terminal-colors.mjs terminal-block-renderer.mjs terminal-input.mjs terminal-settings.mjs terminal-keyboard.mjs terminal-osc52.mjs terminal-reconnect.mjs wheel-sensitivity.mjs oled-border-size.mjs workspace-concurrency.mjs pane-content-sync.mjs terminal-fit-scheduler.mjs vendor assets
var Files embed.FS
