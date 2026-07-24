# Task 067: Tray self-update action

Status: complete

Add a user-facing Update action to Tessera's native Windows and macOS tray
menu.

## Requirements

- Show an Update item in the native tray menu when self-update is available in
  the running build.
- Run the existing updater check and installation flow without opening the
  browser.
- Keep the tray event loop responsive while checking and downloading.
- Disable repeated activation while an update is in progress.
- Show useful tray-item states for checking, up-to-date, failure/retry, and
  restart.
- Request the same verified restart lifecycle used by browser-initiated
  updates after installation succeeds.
- Keep Start, Stop, Configure, and Exit behavior unchanged.
- Do not expose the item on unsupported/server-only builds.

## Verification

- Add focused tests for tray update result states and callback behavior.
- Run desktop, updater, and command lifecycle tests.
- Run `go test ./...`, `go vet ./...`, and `git diff --check`.

## Implementation

- Added an Update item between Configure and Exit when an updater is available.
- Run update checking and installation on a dedicated tray callback goroutine,
  keeping the native event loop responsive and disabling duplicate activation.
- Display Checking for Updates, Up to Date — Check Again, Update Failed —
  Retry, and Restarting states directly in the menu.
- Reuse `Updater.Apply` and `RequestRestart`, so tray and browser updates share
  installation locking, transactional replacement, and verified restart.
- Omit the item when updater initialization fails or native tray support is not
  compiled.
- Added focused state and callback tests covering successful installation,
  already-current releases, and retryable errors.

## Verification results

- `go test ./internal/desktop ./cmd/tessera ./internal/update`
- `go test ./...`
- `go vet ./...`
- `git diff --check`
