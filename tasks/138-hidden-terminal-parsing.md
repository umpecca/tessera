# Task 138: Suspend browser parsing for hidden terminals

Status: complete

Stop parsing terminal output in minimized panes, panes fully covered by a
higher window, and background browser tabs. Drop unapplied browser events
without advancing the applied cursor or building a hidden output backlog.
Keep the host shell running and retain shell-exit notifications.

Restore the latest authoritative snapshot when a terminal that missed output
becomes visible, then apply live events in order. Idle panes resume their
applied cursors and preserve selection and scroll. Suppress hidden reconnect loops and preserve
permanent exit and core compatibility failures. Cover visibility changes,
partial snapshots, stale sockets, shutdown, and recovery with regressions.

The retained-image history scan is already handled by task 137. This task
changes the browser's terminal lifecycle and uses the existing host snapshot
protocol.

Validation: focused lifecycle tests, a sustained-output and snapshot recovery
probe, complete JavaScript/core and Go tests, web build, and diff checks.

Implemented synchronous document visibility updates and per-pane output
suspension for minimization and full coverage. Pausing releases pending parser
tasks and partial snapshots. Hidden socket messages only mark the replica for
snapshot recovery; the socket remains connected for shell exit and failure
notices. Retries and wake recovery wait until the pane becomes visible.

Validation results:

- All 394 JavaScript/core tests passed, including 12 new lifecycle regressions.
- A real WASM probe streamed more than 16 MiB while hidden with zero browser
  parser writes and no queued output. One snapshot restored matching screen
  cells, retained history, image count, and cursor. Subsequent live output
  continued a partially received escape sequence and matched host state.
- Covered and background panes pause, partial coverage remains live, and
  idle hide/reveal resumes without importing a snapshot.
- Hidden shell exit and permanent failures stay settled. Pending retries and
  partial snapshots are released; old sockets cannot mutate restored panes.
- `go test ./...`, `go vet ./...`, and `npm run build:web` passed.
- JavaScript syntax and `git diff --check` passed.

The host still parses output and sends it over the retained WebSocket. This
change removes hidden browser parsing and backlog storage; it does not suspend
the shell or change the existing state protocol.
