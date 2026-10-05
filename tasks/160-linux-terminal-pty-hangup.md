# Report Linux PTY hangups as shell exits

Status: complete; confirmed in Ubuntu amd64 and macOS arm64 CI.

## Request

Fix Ubuntu amd64 failures in the real WebSocket tests for paused terminal output
and small-gap replay. Both receive close code 4502 with a `/dev/ptmx` EIO error
after sending a normal `exit`, rather than the expected clean-exit code 4501.

## Diagnosis

Linux's PTY master read returns EIO when the slave end closes. `unixPty.Read`
currently passes that expected hangup through as a failure. The managed read
loop and process watcher race to record the exit, so the PTY read can classify a
clean process exit as a failure. Merely ignoring EIO would leave the reverse
race: a clean EOF could hide a nonzero process exit.

## Requirements

- Normalize Linux PTY master EIO to EOF at the platform read boundary.
- Let the process watcher report the actual process result after EOF.
- Preserve other read errors, paused lifecycle delivery, and buffered output.
- Keep the existing real PTY/WebSocket assertions and add regression coverage
  for Linux hangup normalization and EOF arriving before the process result.

## Validation

- The new deterministic EOF-before-process-result regression failed against the
  previous implementation, then passed 100 repetitions after the fix on Windows.
- Both reported real WebSocket tests and the read-loop/process-watcher tests
  passed 10 repetitions on Windows.
- The full Go suite passed with a temporary overlay changing only the server
  test's fixed port to an ephemeral port, avoiding the running development host.
- `go vet ./...` and `git diff --check` passed.
- Compiled terminal and HTTP API test executables, and passed vet for those
  packages, for Linux amd64/arm64 and Darwin amd64/arm64 with CGO disabled.
- Added Linux-only real PTY tests for raw EIO versus adapted EOF, buffered output
  before hangup, and preservation of other read errors. Added a Unix real-shell
  regression for paused lifecycle delivery of both exit 0 and exit 7.
- Native Linux/macOS execution was unavailable on the Windows development host;
  platform-only regressions were compiled but not run locally. The subsequent
  [Ubuntu amd64 CI job](https://github.com/umpecca/tessera/actions/runs/37377848086/job/111992164136)
  and [macOS arm64 CI job](https://github.com/umpecca/tessera/actions/runs/37377848086/job/111992164168)
  passed the full Go suite on commit
  `e6e614927a879c1482c150b33380993002428a06`, confirming the platform regressions.
  For additional repetitions on Ubuntu:

  ```sh
  go test ./internal/terminal ./internal/httpapi -run 'TestLinuxPty|TestUnixTerminalExitReportsProcessStatus|TestHiddenTerminalWebSocketStopsOutputAndKeepsExitLive|TestSmallHiddenGapReplaysOverRealTerminalWebSocket' -count=20
  ```

The existing WebSocket assertions were retained. This changes production exit
classification rather than accepting the erroneous failure close code in tests.

Kernel reference: [Linux v6.12 N_TTY read](https://github.com/torvalds/linux/blob/v6.12/drivers/tty/n_tty.c),
which returns EIO when `TTY_OTHER_CLOSED` is set after buffered input is drained.
