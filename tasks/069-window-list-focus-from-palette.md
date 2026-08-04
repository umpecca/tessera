# Task 069: Window list focus when opened from the command palette

Status: complete

Running **Window List** from the command palette while a Terminal pane was
focused left keyboard focus on the terminal, so the picker's arrow keys were
typed into the shell instead of moving the selection.

`runPaletteCommand()` hides the palette before running the command, and
`hideCommandPalette()` schedules `restorePaneFocusAfterOverlayDismiss()`. The
command then opens the window list, which schedules its own
`windowListPanel.focus()`. The pane-focus restore raced the panel focus and the
terminal ended up owning the keystrokes.

- `restorePaneFocusAfterOverlayDismiss()` now bails when the command palette or
  window list is open at the time its frame runs: an overlay that is still
  visible owns keyboard focus, not the pane behind it.

Verification (browser, terminal + browser + text editor panes, terminal
focused):

- Command palette -> "Window List" -> `document.activeElement` is the window
  list panel; `ArrowDown`/`ArrowUp` move `is-selected` between rows and nothing
  reaches the terminal; `Enter` picks the row and returns focus to that pane.
- Regression: `Ctrl+K` then `Escape`, and `Ctrl+L` then `Escape`, both restore
  focus to the terminal pane.
- `node --check web/app.js`, `node --test web/*.test.mjs`, `go test ./...`
