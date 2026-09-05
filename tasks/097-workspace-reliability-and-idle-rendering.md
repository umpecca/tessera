# Task 097: Workspace reliability and idle rendering

Status: complete

Fix global pane shortcuts acting behind dialogs, asynchronous terminal startup
surviving pane removal, final workspace saves racing their own pending save,
and active terminals continuously requesting idle animation frames.

Preserve normal shortcuts, reject saves from stale unrelated clients, and keep
cursor blinking and output rendering responsive without a permanent frame loop.

Implemented:
- Dialog and picker checks in the shared shortcut resolver also cover keys
  relayed from Browser panes. Palette/window-list toggles remain available.
- Terminal startup checks pane membership after loading dependencies. The
  terminal adapter suppresses both immediate and deferred startup autofocus.
- Saves use client-generated 128-bit next-revision tokens. A final save can
  atomically match the loaded revision or its own pending request's token;
  it cannot overwrite an unrelated client's later revision. Final content is
  included when a request is pending, including edits reverted since its send.
- Cursor blinking requests one frame per 530 ms tick. Hidden/minimized panes
  stop the timer; output, scrolling, clear, and reset request their own frames.

Validation:
- All 183 frontend tests passed; web build and JavaScript syntax check passed.
- `go test ./...` passed, including both save arrival orders and a third-client
  conflict regression. `git diff --check` passed.
- Isolated browser instance: Ctrl+Backspace edited a rename field without
  destroying its pane; freshly typed worksheet text and focus survived refresh.
- Real bundled terminal: five scheduled renders in 2.2 seconds while blinking,
  zero while hidden, startup preserved input focus, inactive cursor was hidden.

The browser's existing keepalive payload limit still applies to large final
saves. This fixes revision ordering; it does not guarantee network delivery
after a tab is closed or the browser/process is terminated.
