# Task 082: Prevent terminal resize from stalling the browser

Status: complete

Resizing the browser or changing a Terminal pane's layout can make a busy
full-screen TUI such as Claude Code render the Tessera page unresponsive. The
PTY survives and reconnecting after a page refresh usually restores the pane,
which points to browser-main-thread starvation in the resize/redraw path rather
than a dead terminal process.

## Requirements

- Keep the browser responsive while a Terminal pane is dragged, maximized,
  restored, docked, or resized with the viewport.
- Do not send a stream of intermediate PTY grid sizes while geometry is still
  changing; always deliver the final settled grid size.
- Preserve immediate initial sizing and sizing after WebSocket reconnect.
- Preserve terminal input, output ordering, scrollback, focus, cursor,
  minimization, and rendering behavior.
- Avoid hiding a real terminal disconnect or process exit.
- Keep the change local to terminal fitting/resizing unless measurement shows
  that output parsing also needs bounded scheduling.

## Verification

- Add focused scheduler tests for burst coalescing, delayed final delivery,
  reconnect sizing, cancellation/disposal, and unchanged dimensions.
- Run `node --test web/*.test.mjs`.
- Run `node --check web/app.js` and the changed terminal modules.
- Run `npm run build:web` and `go test ./...`.
- Run `git diff --check`.
- Where browser automation permits, exercise repeated maximize/restore and
  pane resizing with a redraw-heavy terminal workload and confirm the page
  remains responsive and the PTY receives the final dimensions.

## Implementation

- `TerminalFitScheduler` continues to coalesce local fits by animation frame,
  but schedules PTY grid delivery on a 120 ms trailing timer. Each new fit
  replaces that timer, so a geometry burst sends only its final dimensions.
- Explicit socket-open sizing stays immediate and cancels a pending delayed
  send. This preserves startup and reconnect behavior without sending a later
  duplicate.
- Terminal disposal now cancels both a pending fit frame and a pending grid-size
  timer.
- The Ghostty resize callback uses delayed grid delivery; terminal output and
  input paths are unchanged.

## Verification results

- `node --test web/*.test.mjs` (135 tests passed)
- `node --check web/app.js` and `node --check web/terminal-fit-scheduler.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
- Browser smoke test with a live PowerShell PTY: the page stayed responsive
  through 20 maximize/restore cycles and five large/small drag-resize cycles
  while a redraw workload watched terminal width changes. The terminal kept
  rendering and returned to an interactive prompt.
