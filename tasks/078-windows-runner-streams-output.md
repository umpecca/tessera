# Task 078: Fix Windows runner streaming test

Status: complete

Fix the Windows amd64 failure in `TestRunnerStreamsOutputAndTracksCwd`, which
currently reports exit code 1 instead of 0 after approximately 10 seconds.

- Reproduce and identify the Windows-specific failure.
- Preserve streamed stdout/stderr delivery, cwd tracking, and exit-code
  reporting on every supported platform.
- Add or adjust focused regression coverage where needed.
- Verify the focused runner tests and the full Go test suite.

The runner itself completed normally in 50 consecutive focused repetitions,
including the two-second streaming test, and also passed under full-suite
package concurrency. The reported 10.02-second duration exactly matched this
test's context deadline: on a loaded Windows hosted runner, delayed startup of
a fresh PowerShell process was being converted into a misleading exit code 1.

Raised the completion deadline from 10 to 30 seconds. A real hang remains
bounded, while transient Windows process-start pressure no longer fails the
build. The test now checks `ctx.Err()` immediately after the event stream
closes, so any future deadline failure is reported explicitly instead of as an
incorrect command exit code.

Verification:

- `go test ./internal/shell -run 'TestRunnerStreamsOutputAndTracksCwd|TestRunnerEmitsOutputBeforeCommandExit' -count=50`
- `go test ./...`
