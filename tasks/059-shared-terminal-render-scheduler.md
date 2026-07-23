# Task 059: Shared terminal render scheduler

Status: complete

Reduce idle browser and WASM work from multiple Ghostty Web terminal panes by
replacing each terminal's independent continuous animation loop with one
Tessera-owned scheduler.

## Background

Ghostty Web starts a `requestAnimationFrame` loop for every opened terminal.
Tessera already enables cursor blinking only for the active terminal, so
inactive terminals do not need continuous frames. Minimized terminals do not
need rendering at all until they are restored.

## Requirements

- Replace per-terminal continuous render loops with one shared animation-frame
  scheduler.
- Keep continuous rendering only for the active, visible terminal so cursor
  blinking remains smooth.
- Render visible inactive terminals on demand when terminal output or another
  explicit redraw request occurs.
- Do not render minimized terminals, including when background output arrives.
- On restoring a minimized terminal, render its latest state immediately and
  resume continuous rendering if it is active.
- Pause continuous terminal rendering while the document is hidden and redraw
  visible terminals when the document becomes visible again.
- Preserve terminal parsing while rendering is paused: WebSocket output must
  continue updating Ghostty's terminal state and scrollback.
- Preserve resize, focus, cursor visibility, selection, hyperlink, mouse,
  reconnect, and terminal disposal behavior.
- Ensure disposed terminals cannot remain registered with the shared
  scheduler.
- Keep the Ghostty-specific private-field access isolated in the terminal
  entry adapter so application code uses explicit render-state methods.

## Verification

- Add focused scheduler tests for shared frame coalescing, continuous versus
  on-demand terminals, paused/minimized terminals, restoration, document
  visibility, and disposal.
- Verify terminal activation and minimization update scheduler state.
- Run all frontend tests, `node --check web/app.js`,
  `node --check web/terminal-entry.js`, `npm run build:web`, `go test ./...`,
  and `git diff --check`.

## Implementation

- Added a Tessera-owned scheduler that coalesces requested terminal redraws
  into one browser animation frame and keeps at most one shared frame pending.
- Adapted Ghostty Web at `terminal-entry.js`: its per-instance permanent loop
  now registers with the shared scheduler, while terminal writes request
  on-demand redraws.
- Keep only the active, non-minimized terminal continuous for cursor blinking.
  Inactive terminals redraw when output arrives without polling every display
  frame.
- Pause minimized terminals completely while continuing to parse WebSocket
  output into Ghostty's terminal state. Restoring schedules an immediate
  redraw of the accumulated state.
- Disable the scheduler while the document is hidden and redraw every
  non-minimized terminal when visibility returns.
- Unregister disposed terminals before releasing Ghostty resources.

## Verification results

- `node --test web/*.test.mjs` (52 tests passed)
- `node --check web/app.js`
- `node --check web/terminal-entry.js`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
