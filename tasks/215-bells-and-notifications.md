# Task 215: Bells and notifications (BEL, OSC 9, OSC 777)

Status: complete (iPad check pending)

## Request

Show bells and desktop notifications from terminal programs, marking a
window that isn't being looked at (with tasks 213 and 214).

## Findings

- The core parses BEL and OSC 9 / OSC 777 notifications (`show_desktop_
  notification`, title and body; OSC 9 has no title, and OSC 9;4 progress is
  separate), and the WASM handler dropped both.
- Ghostty's OSC parser keeps a notification in a fixed buffer of about 2 KiB;
  longer ones never reach the handler.
- Output for hidden, minimized or covered windows is paused: those
  connections stay open but get no state frames. They are the windows an
  alert is for, so alerts can't travel with output. Audio events already go
  as separate JSON messages that paused connections still get.
- A browser may be disconnected when an alert happens (iPad in the
  background), and the host's core sees every byte once, so the host is the
  place to notice alerts.
- Safari allows `Notification.requestPermission()` only in a click; on iPad
  only Home Screen web apps have notifications, and WKWebView has none.

## Changes

- `internal/terminalcore/source/attention_api.zig`,
  `scripts/patch-terminal-core.mjs`: the handler counts bells and queues
  notifications (title, zero byte, body; at most 8 KiB each, 64 KiB queued).
  `tessera_bell_count`, `tessera_notification_read`.
- `internal/terminalcore/core.go`: `BellCount`, `Notifications`.
- `internal/terminal/attention.go`, `manager.go`: after each write the host
  turns new bells and notifications into `terminal-alert` messages (epoch,
  id, kind, title, body) for every attachment, paused or not, at most one
  bell a second and notifications in bursts of five then one a second, eight
  queued per connection. The latest alert no browser has shown waits, and a
  bell never replaces a waiting notification. `SeenAlert(epoch, id)` clears
  it.
- `internal/httpapi/terminal.go`: alerts go out as they come and the waiting
  one when a connection starts; `{"type":"alert-seen"}` from the browser.
- `web/terminal-attention.mjs` (embedded): takes each alert once per shell,
  cleans and shortens its text, keeps a waiting notification over a later
  bell, labels, notice text, system notifications, and `TerminalNotices`
  (one per window in the page's corner, three at most, eight seconds,
  click to open the window).
- `web/app.js`: an alert in the window being looked at is marked seen at
  once; any other marks the window (a dot on its title-bar icon, `[bell]` or
  `[notification]` in the window list, Deskbar and switcher, and an outline
  on the window-list button) until it is shown, which tells the host.
  Notifications also show a notice, and a system notification while the
  page is in the background if **Settings → Terminal → System
  notifications** is on (shown only where the browser has notifications;
  turning it on asks permission). `web/terminal-entry.js` drains the
  browser core's queue. `web/styles.css`.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: bells counted (not the BEL ending an
  OSC; reset keeps counting); OSC 9, OSC 777 and UTF-8 queued and drained;
  progress reports, empty and oversized ones not; the 64 KiB bound.
- `internal/terminal/attention_test.go`: paused and visible attachments get
  the same alerts; the waiting alert, seen by id and only for this shell;
  rate limits and the per-connection queue.
- `internal/httpapi/terminal_transport_test.go`: over a real WebSocket and
  `/bin/sh`, a paused connection gets a notification, a later connection is
  told of it, and after `alert-seen` the next is told only of a newer bell.
- `web/terminal-attention.test.mjs`, `web/terminal-hidden-output.test.mjs`:
  alert handling, marking and clearing, notices, system notifications.
- Real host and zsh, headless Chrome: a background window running
  `printf '\e]777;notify;Build;Done in 42s\a'` and a bell got the dot,
  `[notification]` in lists, the window-list outline and a notice; clicking
  the notice brought it forward and cleared everything. No page errors.
- Not yet tried on the iPad or in Safari, including system notifications.
