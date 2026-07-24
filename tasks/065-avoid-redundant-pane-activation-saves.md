# Task 065: Avoid redundant pane activation saves

Status: complete

Prevent clicks inside an already-active, frontmost pane from causing an
unchanged workspace document to be persisted.

## Requirements

- Continue focusing the clicked pane.
- Persist when the active pane changes.
- Continue raising and persisting a pane when another pane is above it.
- Do not allocate a new z-index or schedule a workspace save when the clicked
  pane is already active and frontmost.
- Apply the behavior consistently to terminal and non-terminal panes.

## Verification

- Added focused tests for frontmost, obscured, and tied pane stacking.
- Embedded the new browser module in the server binary.
- Ran the frontend tests, JavaScript syntax checks, web bundle build, Go tests,
  and `git diff --check`.

## Verification results

- `node --test web/*.test.mjs` (64 tests passed)
- `node --check web/app.js`
- `node --check web/pane-activation.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
