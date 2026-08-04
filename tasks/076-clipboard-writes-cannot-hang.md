# Task 076: A clipboard write cannot hang forever

Status: complete

Copying inside Fresh in a Terminal pane on macOS put nothing on the system
clipboard, with no error anywhere. The operator saw a copy key that did nothing,
and pasting into another application produced the previous clipboard contents.

The cause is a browser permission prompt. `navigator.clipboard.writeText()`
needs either transient user activation or the `clipboard-write` permission. An
OSC 52 copy has neither: it arrives over the terminal socket in its own task,
not from the keystroke that triggered it, so Chrome raises a permission prompt —
and leaves the promise **pending**, neither resolved nor rejected, until the
prompt is answered. `writeClipboardText()` awaited it with no timeout, so:

- the copy was lost silently, since the `catch` that reaches the
  `execCommand("copy")` fallback never ran, and
- `applyTerminalClipboardWrite()` chains through `terminalClipboardWrites`, so
  every later terminal copy queued behind the pending one and was never
  attempted either.

A prompt that is dismissed, ignored, or missed therefore disables terminal
copying for the life of the page. This is distinct from a *refused* write, which
rejects promptly with `NotAllowedError` and already fell through to the fallback
correctly.

Fresh's own `[NSPasteboard _setData:forType:index:usesPboardTypes:] returns
false` message, which appears in the pane around the same time, is unrelated —
it is Fresh's host-side pasteboard write failing and writing to stderr, which
lands in the PTY and paints over its own display. The OSC 52 sequence still
arrives complete and ahead of that text, so it is not what breaks the copy.

## Requirements

- Bound how long a clipboard write may take before the fallback is used.
- Keep telling a refused write apart from a stalled one, so a rejection still
  reaches the fallback the way it already did.
- Never leave the terminal clipboard write queue stalled behind one write.
- Leave a successful write on its existing path, with no added delay.

## Implementation

- `settledWithin(promise, milliseconds)` races a promise against a timer and
  resolves whether it settled in time. A rejection still propagates, so the
  existing `catch` continues to handle refusals.
- `writeClipboardText()` uses it with `clipboardWriteTimeoutMs` (1.5 s). A write
  that has not settled by then falls through to `copyTextWithHiddenField()`,
  whose `execCommand("copy")` runs synchronously and needs no permission.

## Verification

- `node --test web/*.test.mjs` (104 tests passed), `node --check web/app.js`
- `go test ./...`
- Real-browser check on macOS (Chrome 150), driving a Terminal pane over CDP
  with `navigator.clipboard.writeText` replaced by a promise that never settles,
  which is what a live permission prompt produces:
  - Before: the write hung, the system clipboard was unchanged, no status
    appeared, and a second OSC 52 copy was never attempted at all.
  - After: the write times out, `execCommand("copy")` succeeds, and the text
    reaches the system clipboard — `COPY_WITH_PENDING_WRITE`, then
    `SECOND_COPY_AFTER_PENDING`, so the queue keeps moving.
  - When the fallback also fails, "Clipboard blocked" is reported instead of
    silence.
  - Unchanged: a granted write still resolves on the normal path, and a denied
    write still rejects with `NotAllowedError` and lands via the fallback.

## Note on the harness

The CDP driver reused whichever Chrome already held the debug port, so an
instance left over from an earlier run served the `app.js` that was on disk when
*it* started. The first runs of this fix were measured against stale code and
looked like the timeout never fired. `launch()` now kills any Chrome on the port
first. Tasks 074 and 075 were re-verified against a clean instance.
