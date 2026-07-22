# Task 051: Reliable self-update restart

Status: complete

Make Tessera restart itself after an in-app update without requiring a
watchdog, service manager, or other supervising process, with particular focus
on the failed relaunch observed on macOS.

## Requirements

- Preserve the existing graceful shutdown before starting the installed
  replacement so the HTTP listener, terminal sessions, audio processes, and
  SQLite store are released cleanly.
- On macOS and other Unix platforms, replace the stopped Tessera process with
  the updated executable using an in-place process exec. Preserve the original
  command-line arguments, environment, working directory, and standard I/O.
- On Windows, launch the replacement independently and release the child
  process so it is not coupled to cleanup of the exiting updater process.
- Keep restart behavior self-contained; do not require launchd, systemd, a
  Windows service, shell loop, or external watchdog.
- Return and log actionable errors when the replacement cannot be executed or
  launched.
- Keep the installed executable path captured before the updater swaps files,
  including the existing symlink-resolution behavior.
- Document the platform restart handoff in the updater architecture and user
  documentation.

## Verification

- Add a Unix subprocess test proving the updater execs the replacement and
  preserves arguments and environment.
- Add focused coverage for the Windows child-launch configuration where it can
  be tested without starting a real Tessera server.
- Run updater and command lifecycle tests, `go test ./...`, and
  `git diff --check`.

## Completion

- Replaced the Unix child-process relaunch with an in-place `exec` of the
  installed binary after graceful shutdown, retaining arguments, environment,
  working directory, process identity, and standard streams.
- Kept the required Windows child handoff and explicitly released the started
  process handle so it survives updater cleanup.
- Added a real Unix subprocess/exec test and a Windows released-child startup
  test, including failure coverage for an unavailable Unix replacement.
- Documented the supervisor-free platform handoff in the README and
  architecture guide.
- Verified focused updater and lifecycle tests, the macOS ARM64 test build,
  `go test ./...`, and `git diff --check`.
