# Task 023: Fix Linux runner stdout race

Status: complete

Fix the Linux failure in `TestRunnerStreamsOutputAndTracksCwd`, where a fast
shell process can exit before Tessera finishes reading its stdout pipe.

- Let `os/exec` coordinate stdout/stderr draining with `cmd.Wait()`.
- Preserve streamed output, cwd marker parsing, and exit-code reporting.
- Run the focused shell test repeatedly and run the full Go test suite.

The initial fix waited for both pipe readers before calling `cmd.Wait()`. That
avoided Linux's early-close race but deadlocked on Windows, where the readers
did not receive EOF until `Wait` closed the process pipes. Replace the explicit
`StdoutPipe` / `StderrPipe` lifecycle with streaming `io.Writer` values managed
by `os/exec`, so `Wait` drains output before returning on both platforms.

Implemented `stdoutEventWriter` and `rawEventWriter` for live event delivery.
The stdout writer retains the existing cwd and exit-marker framing and flushes
any final partial line after `Wait` returns.

Verification:

- `go test ./internal/shell -run 'TestRunnerStreamsOutputAndTracksCwd|TestRunnerEmitsOutputBeforeCommandExit' -count=25`
- `go test ./internal/runs -run TestManagerPersistsOutputAfterSubscriberLeaves -count=20`
- `go test ./...`
- `git diff --check -- internal/shell/runner.go tasks/023-linux-runner-stdout-race.md`

Direct Linux execution was unavailable locally, so the GitHub Actions Linux
job remains the final platform-specific verification.
