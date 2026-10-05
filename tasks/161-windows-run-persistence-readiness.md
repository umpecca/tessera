# Stabilize Windows run persistence coverage

Status: implemented; hosted Windows CI confirmation pending.

## Request

Fix the Windows amd64 CI timeout in
`TestManagerPersistsOutputAfterSubscriberLeaves`, which stayed active past its
20-second completion deadline in a 25.44-second test run.

## Evidence

- The test passes 20 repetitions on the local Windows host.
- The CI log has no output or process-start milestone for this command, so it
  cannot distinguish slow PowerShell startup, storage delay, and a process hang.
- The test starts its completion timeout immediately after run registration.
  Its fixed sleep is also the only mechanism meant to delay output until after
  unsubscribe.
- Its `done` assertion also matches the command text saved before execution,
  allowing missing command output to pass unnoticed.

## Change

- Use actual command output to acknowledge readiness with a separate bounded
  startup budget, then unsubscribe and release a filesystem gate.
- Keep the post-release completion deadline at 20 seconds.
- Assert that the complete transcript contains the output emitted after
  unsubscribe, and reload it from a reopened disk-backed store.
- Cancel and reap the test's command before store and directory cleanup.
- Keep production run-manager, shell runner, and release workflow behavior.

## Validation

- Passed the revised focused test 30 times on Windows. The baseline passed 20
  repetitions locally, so the hosted-worker timeout was not reproduced here.
- A temporary test overlay omitted the post-unsubscribe output. The test failed
  specifically on the exact persisted-transcript assertion, confirming command
  text alone cannot satisfy the output check.
- Passed the full uncached Go suite with `GOMAXPROCS=2` under package concurrency:
  `go test -count=1 -overlay .cache/review/windows-run-persistence-161/go-overlay.json ./...`.
  The temporary overlay changes only the server test's fixed port to an
  ephemeral port, avoiding the running development host.
- Passed `go vet ./...` and `git diff --check`.
- Compiled the run-manager tests and passed vet for Linux amd64 and Darwin
  arm64/amd64 with CGO disabled. The modified Unix fixture was not run locally.
- The hosted failure's exact cause remains unconfirmed; the revised test has
  separate diagnostics for failure to produce readiness within 60 seconds and
  failure to finish within 20 seconds after output is released.
- No production manager, runner, or release-workflow changes. Hosted Windows CI
  must run the updated test to confirm the reported failure is resolved.

The [reported Windows job](https://github.com/umpecca/tessera/actions/runs/37377848086/job/111992164020)
ran commit `e6e614927a879c1482c150b33380993002428a06`. Its Ubuntu amd64 and macOS
arm64 jobs passed the full Go suite, confirming the preceding platform fixes.
