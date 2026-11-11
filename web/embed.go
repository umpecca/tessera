// Package web embeds the Tessera SPA assets served at the web root.
package web

import "embed"

// Files holds the SPA files served by the web server. Build inputs (terminal-entry.js, and the terminal
// render scheduler) are excluded; run `npm run build:web` before `go build`
// when the vendor bundles change.
//
//go:embed index.html manifest.webmanifest app.js styles.css browser-pane.mjs vnc-pane.mjs pane-activation.mjs server-connection.mjs server-update.mjs local-https-settings.mjs ipad-http-guidance.mjs terminal-font.mjs terminal-colors.mjs terminal-block-renderer.mjs terminal-input.mjs terminal-settings.mjs terminal-keyboard.mjs terminal-osc52.mjs terminal-reconnect.mjs terminal-replica.mjs terminal-output-timing.mjs terminal-write-scheduler.mjs wheel-sensitivity.mjs oled-border-size.mjs workspace-concurrency.mjs pane-content-sync.mjs window-switcher.mjs terminal-fit-scheduler.mjs clipboard-bridge.mjs compatibility.mjs terminal-visibility.mjs extensions vendor assets
//go:embed shortcuts.mjs
//go:embed workspace-document.mjs workspace-persistence.mjs settings-persistence.mjs
//go:embed vnc-controller.mjs
//go:embed browser-controller.mjs
//go:embed settings-dialog.mjs
//go:embed interface-font.mjs
//go:embed native-app.mjs
//go:embed terminal-connections.mjs
//go:embed rdp-controller.mjs
//go:embed desktop-panes.mjs desktop-geometry.mjs desktop-interactions.mjs
//go:embed session-navigation.mjs preferences.mjs workspace-background.mjs workspace-lifecycle.mjs
//go:embed browser-view.mjs vnc-view.mjs rdp-session.mjs rdp-view.mjs rdp-dialogs.mjs
//go:embed terminal-view.mjs terminal-input-bridge.mjs phone-workspace.mjs
//go:embed workspace-menus.mjs deskbar.mjs sessions-dialog.mjs settings-view.mjs
//go:embed local-https-dialog.mjs help-dialog.mjs command-palette.mjs
//go:embed window-list-view.mjs session-list-view.mjs window-switcher-view.mjs
//go:embed server-connectivity.mjs clipboard-access.mjs directory-dialog.mjs application-events.mjs
//go:embed rdp-pane.mjs rdp-avc444.mjs rdp-h264.mjs rdp-h264-sps.mjs rdp-kept.mjs rdp-stats.mjs rdp-viewer.mjs rdp-viewer-wire.mjs
//go:embed window-wobble.mjs screensaver.mjs terminal-touch-scroll.mjs
//go:embed terminal-audio.mjs terminal-files.mjs clipboard-image.mjs save-clipboard.mjs
//go:embed terminal-audio-stream.mjs terminal-working-directory.mjs terminal-attention.mjs terminal-progress.mjs terminal-kitty-keyboard.mjs terminal-find.mjs
//go:embed startup.js
//go:embed sign-in.mjs sign-in-settings.mjs password-manager.mjs terminal-prediction.mjs key-readout.mjs phone-view.mjs phone-input.mjs
var Files embed.FS
