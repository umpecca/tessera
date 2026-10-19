# Task 213: Light/dark reports (CSI ? 996 n, mode 2031)

Status: complete (iPad check pending)

## Request

Let programs ask whether a terminal is light or dark and be told when that
changes (with tasks 214 and 215, "implement 1-3").

## Findings

- The core parses `CSI ? 996 n` as `color_scheme` and knows mode 2031
  (`report_color_scheme`), but the WASM handler answered nothing ("Not
  supported in WASM context").
- Ghostty answers `CSI ? 997 ; 1 n` for dark and `; 2 n` for light, from its
  configured theme, and with mode 2031 on reports again when the theme
  changes. It reports nothing when the mode is merely enabled.
- A pane's light/dark mode reaches the host when a browser attaches with
  `colorMode`; switching it rebuilds the pane's view, which reattaches, and
  the host calls `tessera_sixel_configure` only when the mode differs. The
  host's core answers queries; browsers' replies are discarded.

## Changes

- `internal/terminalcore/source/sixel_api.zig`,
  `scripts/patch-terminal-core.mjs`: the handler remembers the mode
  `tessera_sixel_configure` set, answers `CSI ? 996 n` from it, and with mode
  2031 on queues the report when the mode changes.
  `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `5351df174c9fb9ee7220258d1112f1a4be7c7ccdae62ece895d2801c44916664`, with
  tasks 214 and 215; rebuilt again in task 217).
- `internal/terminal/state.go`: `Configure` writes the core's replies to the
  shell after a change.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: the query in each mode, no report
  without 2031, none on enabling it or for the same mode again, one per
  change while on, none after turning it off.
- `internal/terminal/attention_test.go`: through a managed session, the
  query and a mode change under 2031 reach the PTY.
- Real host and zsh, headless Chrome: a program that enabled 2031 and queried
  got `ESC[?997;1n`, then `ESC[?997;2n` and `ESC[?997;1n` as the pane was
  switched to light and back.
- Full JavaScript suite: 711 pass. `go test ./...` fails only on the
  unembedded `screensaver.mjs`, as before. `npm run verify:terminal-core`
  reproduces the core.
- Not yet tried on the iPad.
