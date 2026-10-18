# Task 199: Remove the Ctrl/Cmd+Backspace destroy-window shortcut

Status: complete

## Request

The user kept destroying windows by accident with `Ctrl+Backspace` /
`Cmd+Backspace` and would rather close windows from the command palette.

## Changes

- `web/app.js`: `paneShortcutAction` no longer maps `Ctrl/Cmd+Backspace` to
  `destroyActivePane`, so the key reaches the focused pane like any other.
  **Destroy Window** stays in the command palette (code `DD`, aliases
  `close` and `close window`); its hint now shows the active window's title
  instead of the removed shortcut.
- Help: the Keyboard shortcuts list drops **Destroy active window**; Window
  controls now says to run Destroy Window from the command palette.

## Validation

- `web/pane-interaction.test.mjs`: `Ctrl+Backspace` and `Cmd+Backspace`
  resolve to no action. The dialog-blocking test uses `Ctrl+]` in place of
  the removed shortcut. Full JavaScript suite passes (596).
- Not checked in a browser.
