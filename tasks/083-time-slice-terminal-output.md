# Task 083: Time-slice terminal output parsing

Status: complete

High-volume terminal output, such as a parallel kernel build, can make the
Tessera page unresponsive. Every PTY read becomes a WebSocket message whose
browser handler calls Ghostty's synchronous WASM parser immediately. A steady
stream can therefore monopolize the browser main thread even though terminal
painting itself is already coalesced by animation frame.

## Requirements

- Preserve terminal output bytes and ordering exactly.
- Bound synchronous output parsing per browser task and yield regularly so
  input, layout, and painting remain responsive.
- Split large reconnect replay frames so no multi-megabyte `term.write()` call
  can become one long browser task.
- Keep only one scheduled drain per terminal and avoid rendering more than the
  existing shared render scheduler requests.
- Retain queued output across a resumable WebSocket reconnect, because the
  resume cursor already counts bytes received by the browser.
- Clear queued output when the server explicitly declares a fresh stream.
- Cancel pending work when the terminal view is disposed.
- Preserve OSC 52 filtering, clipboard behavior, terminal responses, input,
  scrollback, resize, and reconnect behavior.

## Verification

- Add focused tests for FIFO order, large-frame splitting, byte/time budgets,
  single-drain scheduling, fresh-stream reset, and disposal.
- Run `node --test web/*.test.mjs`.
- Run syntax checks for `web/app.js` and the new scheduler module.
- Run `npm run build:web`, `go test ./...`, and `git diff --check`.
- Exercise sustained high-volume output in a real browser and confirm the page
  remains responsive while all output eventually reaches the terminal.

## Implementation

- Added one `TerminalWriteScheduler` per terminal view. It preserves FIFO byte
  order while splitting input into at most 16 KiB writes.
- Each browser task parses at most 64 KiB or five milliseconds of output, then
  schedules another zero-delay task so browser input, layout, and painting can
  run between drains.
- Multiple arriving WebSocket messages share one scheduled drain. Ghostty's
  existing render scheduler still coalesces the resulting redraw requests into
  animation frames.
- Resumable reconnects retain the terminal's existing queue, so bytes already
  counted by the resume cursor are not lost. An attach message marked `reset`
  cancels queued bytes from the superseded stream before resetting Ghostty.
- Disposing a terminal cancels its pending drain and releases queued chunks.
- Added the new browser module to the embedded SPA assets.

## Verification results

- `node --test web/*.test.mjs` (140 tests passed)
- `node --check web/app.js` and `node --check web/terminal-write-scheduler.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
- Real-browser test with a live PowerShell PTY: 40,000 lines totaling about
  20 MiB reached the terminal in order through the `__TESSERA_OUTPUT_DONE__`
  sentinel and returned to the prompt. The command palette remained responsive
  and ten maximize/restore transitions completed while output was draining.
