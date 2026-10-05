# Fix macOS shutdown-test readiness

Status: implemented; native macOS CI confirmation pending.

## Request

Fix the macOS build failure in `TestShutdownWaitsForAllWorkspaceCommands`,
which reaches its five-second shutdown deadline.

## Likely cause

The Unix fixture prints `ready` before launching its long-lived `sleep` child.
The test can therefore cancel the shell while it is still forking that child.
A child missed by the process-group kill can keep the output pipes open, so
`cmd.Wait()` and the run's completion channel remain blocked. The existing Unix
shell-runner regression test already avoids this macOS startup race by launching
the background child before printing its readiness marker.

## Change

- Apply the same child-before-readiness ordering to the shutdown fixture.
- Retain both workspace runs, the five-second shutdown deadline, and the
  assertions that neither workspace has an active command afterward.
- Keep production process-group cancellation and Windows command behavior.

## Validation

- Passed shutdown and workspace-isolation tests 25 times each on Windows:
  `go test ./internal/runs -run 'TestShutdownWaitsForAllWorkspaceCommands|TestStopWorkspaceDoesNotCancelOtherWorkspace' -count=25 -timeout=3m`.
- Passed the full Go suite with a temporary overlay that changes only the server
  test's fixed port to an ephemeral port, avoiding the running development host.
- Passed `go vet ./...` and `git diff --check`.
- Compiled `internal/runs` and `internal/shell` test executables for Darwin arm64
  and amd64 with CGO disabled.
- Native macOS execution is unavailable on this Windows host. Confirm in macOS
  CI, or run the focused tests above on a Mac. The timeout remains five seconds;
  no production shutdown logic was changed.
