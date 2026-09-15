# Task 106: Recover terminals after system sleep

Status: complete

Detect when a sleeping computer resumes, then restore live Tessera terminals
without requiring input, scrolling, or a page reload.

## Requirements

- Distinguish a system clock jump from ordinary event-loop delay so background
  tabs do not reconnect merely because their timers were throttled.
- Reconnect live and waiting terminal sockets from their last replicated stream
  position after wake.
- Force a complete terminal canvas redraw after wake.
- Show a compact status until server health and every affected terminal are
  ready again.
- Preserve terminal contents, focus, and existing reconnect behavior.

## Implementation

- Compare wall-clock and monotonic elapsed time on the existing five-second
  health heartbeat, visibility changes, and window focus. On Firefox for macOS,
  the monotonic clock pauses during system sleep, so ordinary timer throttling
  does not look like a wake.
- Treat a page restored from Firefox's back-forward cache as needing the same
  recovery.
- Replace each recoverable terminal socket and resume through the existing
  replica stream coordinates. Late events from the retired socket are ignored.
- Request a full canvas redraw for every terminal, including settled panes that
  should not reconnect.
- Keep a compact live status visible until server health succeeds and each
  reconnecting terminal accepts its attach state, then show `Ready after wake`
  briefly.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (226 tests passed)
- `go test ./...`
- `git diff --check`
