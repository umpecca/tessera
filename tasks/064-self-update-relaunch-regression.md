# Task 064: Self-update relaunch regression

Status: complete

Fix the self-update lifecycle when Tessera successfully downloads and installs
the replacement executable, shuts down the running server, but does not bring
the updated server back online.

## Requirements

- Reproduce or otherwise identify the failure between successful installation,
  graceful shutdown, and replacement startup.
- Restart the installed replacement reliably on every supported desktop
  platform without requiring an external service manager or watchdog.
- Preserve the original arguments, environment, working directory, and
  standard streams where supported.
- Do not start the replacement until the old HTTP listener, terminal sessions,
  audio processes, tray, and SQLite resources have been released.
- Avoid leaving the installation without a runnable executable if handoff
  preparation fails.
- Report actionable restart failures through a durable channel that is still
  available after the old server has stopped.
- Add lifecycle regression tests that exercise the failing handoff rather than
  only proving that a standalone child or `exec` call can start.
- Update the self-update documentation and changelog with the corrected
  lifecycle.

## Verification

- Run focused updater and command lifecycle tests.
- Run platform-specific restart tests or cross-build checks for Windows,
  macOS, and Linux.
- Run `go test ./...` and `git diff --check`.

## Implementation

- Replaced the Unix in-place `exec` handoff with a detached successor in a new
  session, preventing terminal and macOS application teardown from taking the
  new server down.
- Added a one-use readiness marker to every platform handoff. The stopped
  parent now remains alive until the successor confirms that
  `Controller.Start` succeeded.
- Forwarded replacement startup errors through the same marker so the parent
  reports the actual initialization failure instead of assuming that a
  successful process creation means a successful restart.
- Preserved the original arguments, environment, working directory, and
  standard streams while removing stale handoff variables before launch.
- Updated Windows and Unix subprocess tests to require the readiness
  acknowledgement and verify the detached successor launch context.

## Verification results

- `go test ./internal/update ./cmd/tessera`
- Linux amd64 updater test cross-compile
- macOS arm64 updater test cross-compile
- `go test ./...`
- `go vet ./...`
- `git diff --check`
