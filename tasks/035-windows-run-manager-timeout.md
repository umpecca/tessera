# Task 035 — Stabilize Windows run-manager completion test

Status: complete

Fix the Windows amd64 CI failure in
`TestManagerPersistsOutputAfterSubscriberLeaves` without changing production
run behavior or weakening its persistence assertions.

## Diagnosis

- The test passes 30 consecutive runs on Windows locally.
- Its PowerShell child is given a six-second polling deadline, while the failing
  shared CI worker took more than nine seconds overall.
- The command emits only a few events, so channel capacity and subscriber
  removal are not blocking the run; the failure is process-startup timing under
  Windows CI load.

## Change

- Capture the started run's existing `done` channel while holding the manager
  lock.
- After unsubscribing, wait directly for that completion signal instead of
  polling `ActiveRuns` every 50 milliseconds.
- Use a 20-second test timeout to accommodate slow PowerShell startup on shared
  Windows workers, then still assert the run was removed and its output was
  persisted.
- Keep the delayed command so the subscriber is removed before output arrives.

## Verification

- Run the focused test repeatedly on Windows.
- Run `go test ./internal/runs` and `go test ./...`.
- Run `go vet ./...` and `git diff --check`.

## Implementation summary

- Captured the newly registered run under the manager lock and waited directly
  on its `done` channel after unsubscribing.
- Replaced the six-second polling loop with a 20-second completion timeout while
  retaining the active-run removal and persisted-output assertions.
- Passed 30 consecutive focused Windows runs, `go test ./...`, `go vet ./...`,
  and `git diff --check`.
