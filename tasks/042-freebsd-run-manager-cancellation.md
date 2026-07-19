# Task 042 — Fix FreeBSD run-manager cancellation

Status: complete

Fix the FreeBSD failure in `TestStopWorkspaceDoesNotCancelOtherWorkspace`:

```text
stop workspace one: context deadline exceeded
```

## Diagnosis

- Unix worksheet commands run through `/bin/sh -c` with custom stdout and
  stderr writers, so `os/exec` copies output through internal pipes.
- `exec.CommandContext` cancellation kills only the shell process.
- A child such as `sleep` can remain alive after the shell is killed and retain
  the output pipe descriptors. `cmd.Wait()` consequently waits for that child
  to exit before the run manager can close its `done` channel.
- The test uses a five-second command and a four-second stop deadline, exposing
  this process-tree cancellation gap on FreeBSD.

## Change

- Start Unix shell commands in their own process group.
- Override command cancellation to signal the whole process group, ensuring
  descendants release inherited output pipes promptly.
- Keep Windows process configuration unchanged.
- Add a focused shell-runner regression test that cancels a command with a
  long-lived child and requires prompt event-channel closure.

## Verification

- Run the focused shell and run-manager tests.
- Run `go test ./...`, `go vet ./...`, and `git diff --check`.

## Implementation summary

- Unix commands on Linux, macOS, FreeBSD, and OpenBSD now start in isolated
  process groups, and context cancellation sends `SIGKILL` to the group.
- Windows retains its existing hidden-window process configuration.
- Added a Unix-only regression test that waits for a shell command to start a
  ten-second child, cancels it, and requires the event stream to close within
  two seconds.
- Passed focused shell/run-manager tests, the full Go suite, `go vet ./...`,
  `git diff --check`, and FreeBSD/OpenBSD amd64 compile checks for the shell test
  package.
