# Task 214: Focus reports (mode 1004)

Status: complete (iPad check pending)

## Request

Tell programs that enable focus reporting when a terminal gains and loses
focus (with tasks 213 and 215).

## Findings

- ghostty-web exposes `hasFocusEvents()`, but nothing called it, and the
  core's focus flag was never set.
- Ghostty sends `CSI I` / `CSI O` on focus changes while mode 1004 is on, and
  the current state when the mode is enabled. The terminal's flag starts
  focused.
- Sending the report from the browser would race a program turning the mode
  off: the shell would then read `ESC [ I` as typing. Several browsers can
  show one pane.
- Rebuilding a pane's view (light/dark switch) or reconnecting closes the old
  connection before the new one opens, which on first try sent a spurious
  `CSI O`, `CSI I` pair.

## Changes

- `internal/terminalcore/source/attention_api.zig`,
  `scripts/patch-terminal-core.mjs`: `tessera_focus(handle, focused)` sets the
  flag and queues the report under mode 1004; enabling the mode queues the
  current state.
- `internal/terminalcore/core.go`: `SetFocus`; a new core starts unfocused.
- `internal/terminal/attention.go`, `manager.go`: each attachment says
  whether its browser has the pane focused; the pane is focused while any
  does. A focused attachment that closes loses focus after 500 ms unless
  another claims it.
- `internal/httpapi/terminal.go`: `{"type":"focus","focused":…}` from the
  browser.
- `web/app.js`: a pane is focused while it is the active, unminimized window
  and the page is visible and has focus. Changes are sent on activation,
  minimizing, window focus and blur, and visibility changes, and the current
  state on every new connection.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: nothing before the mode, the state
  on enabling, changes only, none after disabling.
- `internal/terminal/attention_test.go`: two browsers (focused while either
  is), a replaced connection keeping focus, a focused browser leaving, a
  closed attachment ignored; `-race`.
- `web/terminal-hidden-output.test.mjs`: reports follow activation, page
  focus and minimizing, and a new connection starts over.
- Real host and zsh, headless Chrome: a program with 1004 on got `ESC[I` on
  enabling, `ESC[O` when another window was made active, `ESC[I` when its own
  was, and nothing extra when the pane switched to light and back.
- Not yet tried on the iPad, where page focus may behave differently.
