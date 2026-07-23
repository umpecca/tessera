# Task 061: Terminal TUI mouse-release recovery

Status: complete

Prevent mouse-aware terminal applications from remaining in a latched selection
or drag state after a secondary click in Tessera.

## Requirements

- Pair every browser-forwarded terminal button press with a matching release.
- Do not drop a release merely because terminal mouse-tracking state changes
  between pointer-down and pointer-up.
- Send a release when the browser produces `pointercancel`, loses pointer
  capture, or opens a native context menu before the normal pointer-up path.
- Reuse the most recent valid terminal-cell position when a cancellation event
  has no usable coordinates.
- Preserve Tessera's local context menu and selection behavior when terminal
  mouse tracking is not active.
- Preserve TUI pointer movement, wheel input, and server-side stale-mouse
  filtering.

## Verification

- Add focused tests for normal release, cancellation fallback, mismatched
  pointers, and one-time state consumption.
- Run all frontend tests, JavaScript syntax checks, `npm run build:web`,
  `go test ./...`, and `git diff --check`.

## Implementation

- Added a small terminal mouse-press state object that records the originating
  pointer, button, and most recent terminal-cell position.
- Once Tessera forwards a press, pointer-up now sends its release without
  rechecking the TUI's current mouse-tracking mode.
- Pointer cancellation, lost pointer capture, a move with no pressed buttons,
  and a macOS context-menu interruption all consume the same state and send
  the missing release at most once.
- Cancellation paths reuse the last valid terminal-cell position rather than
  manufacturing a new position from missing browser coordinates.
- Local non-TUI context-menu behavior remains unchanged.

## Verification results

- `node --test web/*.test.mjs` (56 tests passed)
- `node --check web/app.js`
- `node --check web/terminal-input.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
