# Task 073: Pasting into a Terminal pane is a paste, not typing

Status: complete

Pasting into a TUI editor running in a Terminal pane arrived as a run of single
keystrokes. The text landed correctly, but the application never learned that a
paste had happened, so undo walked the paste back one character at a time.

Task 071 left the platform's paste accelerator to the browser's paste event,
which `ghostty-web` listens for. Its handler does not go through the terminal's
own paste path:

- `Terminal.paste(text)` checks `wasmTerm.hasBracketedPaste()` and emits
  `ESC [ 200~ … ESC [ 201~` when the application enabled DECSET 2004.
- `InputHandler.handlePaste(event)` instead calls `onDataCallback(text)`
  directly, which is the same path as typing — no brackets, ever.

So Tessera's `Ctrl+Shift+V`, `Shift+Insert`, and context-menu Paste (which call
`term.paste()`) were bracketed, while the far more common `Ctrl+V`/`Cmd+V` was
not.

## Requirements

- Deliver a paste through the terminal's paste path so bracketed paste applies
  when the application asked for it.
- Keep using the browser's paste event, which needs no clipboard permission and
  works on insecure origins.
- Do not let `ghostty-web` also handle the same event and paste twice.
- Strip bracketed paste markers out of the pasted text.

## Implementation

- `attachTerminalPasteBridge()` listens for `paste` on the pane body — the
  terminal container's parent — during the capture phase, so it runs before the
  container listener `ghostty-web` installed. Listeners on the same element fire
  in registration order regardless of the capture flag, so the ancestor is what
  makes the ordering reliable. It calls `preventDefault()` and
  `stopPropagation()`, then `term.paste()`.
- The bridge is stored on `rect.terminal` and disposed in `disposeTerminal()`,
  alongside the mouse bridge, so recreating a terminal view (a color mode
  change, for instance) does not stack listeners and paste twice.
- `terminalPasteText()` removes `ESC [ 200~` and `ESC [ 201~` from the clipboard
  text. Clipboard content carrying the end marker would otherwise close the
  bracket early and leave the rest of the paste looking like keystrokes.

## Verification

- `node --test web/*.test.mjs` (98 tests), `node --check web/app.js`,
  `npm run build:web`, `go test ./...`, `git diff --check`
- Real-browser check against a Terminal pane: with bracketed paste off, a paste
  reached the terminal socket as plain text, unchanged from before. After the
  program in the pane enabled DECSET 2004, the same paste reached the socket as
  `ESC [ 200~ pasted as one unit ESC [ 201~`, exactly once — `ghostty-web` did
  not handle the event as well.
- ConPTY passes bracketed paste through to the child: a probe child that enables
  `ENABLE_VIRTUAL_TERMINAL_INPUT` and reads its console input directly received
  `ESC [ 200~`, then `hello pasted world ESC [ 201~` — split across two reads,
  markers intact.
- Fresh 0.4.4 driven through the same ConPTY: a bracketed paste followed by
  `Ctrl+S` saved `hello pasted world`; the same paste followed by one `Ctrl+Z`
  and `Ctrl+S` saved an empty file. One paste, one undo step.
