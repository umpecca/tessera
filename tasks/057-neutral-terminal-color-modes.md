# Task 057: Neutral terminal color modes

Status: complete

Give terminal panes predictable, conventional colors that are independent of
Tessera's decorative workspace themes, while retaining explicit light and dark
terminal modes.

## Background

ANSI/ECMA terminal control sequences define indexed color roles but do not
standardize exact RGB values for the first 16 colors. Tessera will use the
long-established xterm palette as its stable interoperability baseline rather
than recoloring those slots for each application theme.

## Requirements

- Add a validated, persisted per-user terminal color mode with `dark` and
  `light` values.
- Expose the mode under the Terminal section of Settings.
- Use the conventional xterm RGB values for indexed colors 0 through 15 in
  both modes.
- Leave the xterm 256-color cube/grayscale behavior and 24-bit true-color
  values unmodified.
- Change only the default foreground/background, cursor, and selection colors
  between light and dark modes.
- Keep terminal colors independent of the selected Tessera workspace theme.
- Apply a mode change to open terminal panes by recreating only their browser
  terminal view and reconnecting to the existing PTY; do not restart or close
  the underlying shell process.
- Preserve pane font, size, working directory, input handling, and terminal
  reconnect behavior.
- Keep palette definitions and validation in Tessera-owned frontend source.
- Document that indexed RGB values follow xterm because ANSI does not mandate
  an RGB palette.

## Verification

- Add focused frontend tests for normalization, exact palette values, identical
  indexed colors across light/dark modes, and neutral dynamic colors.
- Add migration, store, and HTTP API tests for persistence.
- Verify an open terminal color-mode change reconnects without requesting
  server-side terminal closure.
- Run all frontend tests, `node --check web/app.js`, `npm run build:web`,
  `go test ./...`, and `git diff --check`.

## Implementation

- Added a Tessera-owned terminal color module with the conventional xterm
  base-16 palette and neutral dark/light dynamic colors.
- Persisted a validated `terminalColorMode` per user through migration 037 and
  exposed it under Settings → Terminal → Colors.
- Removed workspace-theme terminal tinting. Both color modes retain identical
  indexed colors and pass 256-color and true-color application output through
  Ghostty Web normally.
- Recreate open browser terminal views on a mode change without sending a
  server-side close request; the existing managed PTY supplies its scrollback
  to the replacement view.
- Documented the palette choice and added focused frontend, migration, store,
  HTTP API, and embedded-module coverage.

## Verification results

- `node --test web/*.test.mjs` (47 tests passed)
- `node --check web/app.js`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
