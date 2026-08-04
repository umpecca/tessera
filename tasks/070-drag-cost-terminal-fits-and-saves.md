# Task 070: Cut the per-pointer-move cost of dragging a window

Status: complete

Moving or resizing a pane runs `setRectangle()` on every pointer move, which
made three things scale with pointer event rate instead of with actual change.

## Coalesced terminal fits

`requestTerminalFit()` scheduled a fresh `requestAnimationFrame` per call, so a
drag queued hundreds of callbacks; each ran `fit.fit()` (a `getComputedStyle` +
layout read) and then sent a `resize` frame over the terminal WebSocket
unconditionally — including while *moving* a pane, where the grid cannot change.

- New `web/terminal-fit-scheduler.mjs` holds a `TerminalFitScheduler` with
  injectable frame functions, matching `TerminalRenderScheduler`. It keeps one
  pending frame per terminal and sends the grid size only when `cols`/`rows`
  differ from the last size sent on that connection.
- `connectTerminalSocket()` resets the tracked size, since a new socket has not
  been told anything; ghostty's `onResize` and the post-fit path share the
  single send.
- `disposeTerminal()` cancels a pending fit and clears `fit`.

## Documents are not resent on geometry saves

`performWorkspaceSave()` serialized every pane's `bufferText` and `editorTabs`
on every save, so dragging a window rewrote all open editor buffers to SQLite
every 250 ms.

- New `web/pane-content-sync.mjs` decides per pane whether to send a document or
  flag it unchanged, against the content this browser last stored successfully.
  The map is rebuilt only from a successful save and cleared on workspace load,
  so a failed or conflicting save resends everything.
- `store.Pane` gained request-only `bufferTextUnchanged`/`editorTabsUnchanged`
  flags; the pane upsert keeps `panes.buffer_text`/`panes.editor_tabs` for a
  flagged field instead of taking the (absent) request value. `omitempty` keeps
  them out of load responses, and `PreservePaneBuffers()` clears the buffer flag
  when it substitutes a running pane's stored transcript.

## Workspace status writes

`setWorkspaceStatus()` was called on every pointer move with identical
`("saving", "Saving...")` arguments and rewrote `hidden`, `dataset.state`,
`textContent`, and `title` each time. It now returns early when nothing changed,
still falling through for a hidden status and for `saved` so its 3 second hide
timer is re-armed.

Verification:

- `node --test web/*.test.mjs` (80 tests), `go test ./...`
- Browser, synthetic 120-move drag of a terminal pane: zero `resize` frames on
  the socket, one workspace save.
- Browser, save payloads: an idle save flags all four panes' documents
  unchanged and carries none; typing in the text editor makes the next save
  carry that pane's `bufferText` and `editorTabs` only, still flagging the other
  three. The typed text survives a reload, so the server kept the stored copies.
- Browser, status: after the "Saved" chip auto-hides at 3 s, a new drag shows
  "Saving..." and then "Saved" again.

Note: the preview tab used for verification does not composite, so
`requestAnimationFrame` never runs there. The fit coalescing is covered by
`web/terminal-fit-scheduler.test.mjs` with injected frame functions rather than
in the browser.
