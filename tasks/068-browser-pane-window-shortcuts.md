# Task 068: Browser-pane window shortcuts

Status: complete

Window-management keystrokes did nothing while a Browser pane's iframe held
keyboard focus: the guest page consumes the event inside its own document, so
it never reaches the SPA's `document`-level `handlePaneKeyboardShortcuts`
listener. `Ctrl+]` and `Ctrl+[` window cycling were the visible symptom.

- The browser proxy bootstrap now installs a capture-phase `keydown` listener
  that relays the window-management keystrokes (`Ctrl+[`, `Ctrl+]`, `Ctrl+K`,
  `Ctrl+L`, `Alt+F7`, `Alt+F9`, `Alt+F10`) to the parent as a
  `tessera-browser-key` message and calls `preventDefault()` so the guest page
  does not also act on them.
- `handlePaneKeyboardShortcuts()` was split so the key-to-action mapping lives
  in `paneShortcutAction()`, shared by the document listener and the relay.
  Actions that previously let the event keep propagating (`Ctrl+Enter`,
  `Alt+F7/F9/F10`) still do.
- The relay handler resolves the sender to its Browser pane by
  `frame.contentWindow`, makes that pane active first (the iframe swallowed the
  click that focused it), and only honors the non-destructive shortcut set —
  page content can post arbitrary messages, so `Ctrl+Backspace`
  (destroy pane) and `Ctrl+Enter` (run pane command) are not relayable.

Verification:

- `node --check web/app.js`
- `go build ./...`, `go test ./internal/httpapi/`, `go test ./...`
- Browser: two panes (text editor + Browser pane proxying `localhost:7332`).
  With focus inside the iframe, `Ctrl+]` and `Ctrl+[` each posted one
  `tessera-browser-key` message and moved `board.dataset.activePaneId` to the
  editor pane; `Ctrl+K` opened the command palette.
