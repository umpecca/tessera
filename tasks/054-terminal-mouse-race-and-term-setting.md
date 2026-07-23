# Task 054: Terminal mouse shutdown race and TERM setting

Status: complete

Prevent browser-generated mouse reports from reaching the shell after a TUI
has disabled mouse tracking, and make the terminal `TERM` value configurable
as a persisted user setting.

## Requirements

- Distinguish browser-generated mouse reports from ordinary keyboard and paste
  input on the terminal WebSocket protocol.
- Track the live DEC mouse-reporting modes from PTY output on the server before
  publishing that output to browser subscribers.
- Drop tagged mouse input when the server's current terminal state has mouse
  reporting disabled, closing the PTY/WebSocket/browser shutdown race without
  filtering ordinary user input.
- Handle mouse-mode control sequences split across PTY read boundaries.
- Preserve the existing Ghostty WASM mouse-state check in the browser as the
  first-line gate.
- Add a persisted per-user terminal `TERM` setting to the Settings UI and user
  settings API/storage model.
- Default the setting to `xterm-256color` for backward compatibility.
- Validate and normalize the setting to a safe terminal-name value; invalid or
  missing values fall back to the default.
- Apply the configured value when creating a new Unix PTY. Existing live PTYs
  retain the environment with which they were started.
- Keep Windows behavior unchanged except for carrying the setting through the
  shared settings model and UI.
- Document the setting and the fact that it takes effect for newly created
  terminal sessions.

## Verification

- Add focused tests for split mouse-mode sequences, enabled/disabled mouse
  input gating, and preservation of normal terminal input.
- Add store, migration, HTTP API, and settings-normalization tests for the
  terminal `TERM` value.
- Add frontend tests for tagged mouse WebSocket messages and the settings UI.
- Run all web tests, `node --check web/app.js`, the complete Go test suite, and
  `git diff --check`.

## Implementation summary

- Tagged browser-generated SGR mouse reports as WebSocket `mouse` messages
  while leaving keyboard and paste input on the existing binary path.
- Added a server-side, chunk-safe DEC mouse-mode tracker and gated tagged mouse
  writes against the latest PTY output state before forwarding them.
- Added migration 035 and a validated per-user `terminalTerm` setting with the
  backward-compatible `xterm-256color` default.
- Added the `TERM` control to Settings and applied it to newly created Unix PTY
  environments without changing live terminals or Windows PTY behavior.
- Documented the setting and covered mouse gating, split sequences, input
  tagging, TERM normalization, persistence, migration, API, and Unix environment
  replacement.
- Embedded the terminal input and settings modules in production builds and
  added a regression test that verifies every static module imported by
  `app.js` exists in the embedded filesystem.
- Passed `node --test web/*.test.mjs`, `node --check web/app.js`,
  `go test ./...`, and `git diff --check`.
