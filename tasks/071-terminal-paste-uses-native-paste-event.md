# Task 071: Terminal paste follows the browser's paste event

Status: complete (macOS check outstanding)

Copying in another macOS app and pasting into a Terminal pane did not work.

`ghostty-web` implements paste itself: `InputHandler.attach()` puts a `paste`
listener on the terminal container, and `handleKeyDown` deliberately returns for
`(ctrl||meta)+KeyV` *without* `preventDefault()` so the browser fires a paste
event that `handlePaste` reads from `event.clipboardData` — no clipboard
permission, works on insecure origins, and bracketed paste is applied. In
`ghostty-web` a custom key handler that returns `true` means "handled", and the
library then calls `preventDefault()` (the inverse of xterm.js). Tessera
returned `true` for `Cmd+V`, cancelling the paste event and substituting
`navigator.clipboard.readText()`. When that read is denied or unavailable,
`readClipboardText()` fell through a blocked `execCommand("paste")` to
`editorClipboardText` — Tessera's *internal* copy buffer — so an external copy
pasted stale text or nothing, silently.

Plain `Ctrl+V` on macOS is a separate casualty: the library swallows it at that
early return, so it never reaches the PTY as `^V`, and macOS does not treat
`Ctrl+V` as a paste accelerator, so no paste event arrives either. The key does
nothing. It stays unbound here (matching Terminal.app), but it is dead rather
than passed through.

- `terminalPasteSource()` replaces `isTerminalPasteShortcut()` and classifies a
  keystroke as `"native"` (the platform's paste accelerator — leave it alone),
  `"clipboard"` (`Ctrl+Shift+V`, `Shift+Insert`, or a Command key off macOS —
  no paste event is coming, so read the clipboard), or `null`.
- The terminal key handler returns `false` for `"native"`, letting the paste
  event through. Copy is intentionally not symmetric: a canvas terminal has no
  DOM selection for the browser to copy, so Tessera still handles `Cmd+C` and
  `Ctrl+Shift+C` itself.
- A clipboard read that falls back to Tessera's own last copy now reports
  "Clipboard blocked" in the workspace status, naming the platform paste key,
  instead of pasting stale text silently. Applies to both the terminal and
  editor paste actions.

Verification (Chromium on Windows, where `Ctrl+V` is the accelerator):

- `Ctrl+V` keydown on the terminal container leaves `defaultPrevented` false;
  `Ctrl+Shift+V` and `Shift+Insert` are still consumed; ordinary keys unchanged.
- A `paste` event carrying "clipboard-from-another-app" reaches the PTY as those
  bytes over the terminal socket.
- The `Ctrl+Shift+V` path hit a real clipboard-read denial in that browser and
  surfaced "Clipboard blocked" with the guidance text, rather than failing
  quietly.
- `node --test web/*.test.mjs` (82 tests), `go test ./...`

Not verified: macOS itself. The Apple branch of `terminalPasteSource()` is
covered by unit tests only — `Cmd+V` into a TUI application still needs a check
on a Mac.
