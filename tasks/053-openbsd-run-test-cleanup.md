# Task 053: Fix OpenBSD run-manager test cleanup

Status: complete

Fix the OpenBSD failure in
`TestStopWorkspaceDoesNotCancelOtherWorkspace` where the test's automatic
temporary-directory cleanup reports:

```text
TempDir RemoveAll cleanup: unlinkat .../001: directory not empty
```

## Diagnosis

- The failing `/001` path is the test's first `t.TempDir()`, which contains its
  SQLite database, rather than either worksheet command's working directory.
- The run-isolation assertions and both `StopWorkspace` calls have completed
  before Go reports the cleanup error.
- This test verifies cancellation scoping, not database-file persistence, so a
  disk-backed SQLite database adds an unrelated platform cleanup dependency.

## Requirements

- Use Tessera's supported in-memory SQLite store for this run-isolation test.
- Keep the command working directories isolated and retain the existing
  two-workspace cancellation assertions.
- Do not weaken `StopWorkspace` synchronization or skip cleanup errors.
- Do not change production run-manager, shell-process, or store behavior for a
  test-only temporary database race.
- Record the OpenBSD cleanup regression alongside the existing cross-platform
  cancellation coverage.

## Verification

- Run the focused run-manager and shell cancellation tests repeatedly.
- Run `go test ./...` and `git diff --check`.
- Cross-compile the relevant test packages for OpenBSD amd64.

## Completion

- Changed only `TestStopWorkspaceDoesNotCancelOtherWorkspace` to use Tessera's
  supported in-memory SQLite store, removing its unrelated temporary database
  directory and OpenBSD cleanup race.
- Preserved separate command working directories, both workspace runs, scoped
  cancellation assertions, and synchronous `StopWorkspace` behavior.
- Passed the focused test 20 consecutive times, cross-compiled the run-manager
  and shell test packages for OpenBSD amd64, and passed `go test ./...` and
  `git diff --check`.
