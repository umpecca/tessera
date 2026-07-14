# Task 023: Fix Linux runner stdout race

Status: complete

Fix the Linux failure in `TestRunnerStreamsOutputAndTracksCwd`, where a fast
shell process can exit before Tessera finishes reading its stdout pipe.

- Complete stdout and stderr reads before calling `cmd.Wait()`.
- Preserve streamed output, cwd marker parsing, and exit-code reporting.
- Run the focused shell test repeatedly and run the full Go test suite.

Implemented by waiting for both pipe-reader goroutines before calling
`cmd.Wait()`, preventing `Wait` from closing the pipes while unread output is
still buffered.

Verification:

- `go test ./internal/shell -run TestRunnerStreamsOutputAndTracksCwd -count=100`
- `go test ./...`
- `git diff --check -- internal/shell/runner.go tasks/023-linux-runner-stdout-race.md`

Direct Linux execution was unavailable locally, so the GitHub Actions Linux
job remains the final platform-specific verification.
