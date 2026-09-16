# Task 109: Prevent stale terminal geometry

Status: complete

Terminal contents can intermittently retain an older grid after a pane layout
change, making the canvas appear cropped until another minimize, maximize, or
page refresh forces a fit.

## Requirements

- Never discard the final fit request in a rapid sequence of pane resizes.
- Preserve resize debouncing and delayed PTY grid notifications.
- Recheck visible terminal geometry after a tab becomes visible or the browser
  recovers from sleep.
- Dispose all fit timers with the terminal.
- Add a deterministic regression test for the dropped-final-resize race.

## Cause

The fit add-on uses a 50 ms guard after asking the terminal to resize. Both
explicit pane-fit requests and ResizeObserver notifications were discarded
during that guard. When the final layout change landed there, the terminal
kept an intermediate grid indefinitely.

## Implementation

- Fit requests received during the guard are retained and replayed as soon as
  the guard releases.
- ResizeObserver continues debouncing notifications but no longer discards
  them solely because a resize is in progress.
- The debounce and guard timers are tracked and cancelled on disposal.
- Visible terminals are explicitly measured after tab visibility recovery and
  browser sleep recovery to cover throttled legacy-browser observers.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (233 tests passed)
- `go test ./...`
- `git diff --check`
