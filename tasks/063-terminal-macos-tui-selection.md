# Task 063: macOS TUI secondary-click selection cleanup

Status: complete

Prevent a macOS secondary click forwarded to a mouse-aware terminal application
from leaving ghostty-web's local selection layer latched across the terminal.

## Requirements

- Preserve the conventional terminal behavior: unmodified mouse input belongs
  to a mouse-aware TUI, while modifier-assisted input remains available for
  Tessera's local selection and context menu.
- Do not reserve right-click for Tessera when terminal mouse tracking is active.
- Clear a renderer selection only when it appeared during the reported
  context-menu gesture.
- Preserve any local terminal selection that existed before the gesture.
- Tolerate terminal disposal or renderer versions without selection APIs.

## Implementation

- Record whether ghostty-web had a local selection when Tessera begins
  forwarding a mouse press.
- When the matching browser context-menu event is owned by the TUI, finish the
  forwarded press and clear the renderer only if a new local selection appeared
  during that gesture.
- Keep the existing modifier override and TUI mouse routing unchanged.

## Verification

- Added focused tests for new-selection cleanup, existing-selection
  preservation, missing APIs, and disposed terminals.
- Run all frontend tests, JavaScript syntax checks, `npm run build:web`,
  `go test ./...`, and `git diff --check`.

## Verification results

- `node --test web/*.test.mjs` (58 tests passed)
- `node --check web/app.js`
- `node --check web/terminal-input.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
