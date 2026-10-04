# Task 125: Bound terminal browser backlog

Status: complete

Prevent sustained high-volume terminal output, such as a Linux kernel and
userspace build, from growing the browser's unapplied terminal-event queue
without limit.

Track the output bytes accepted from the WebSocket but not yet applied to the
browser terminal replica. When that backlog exceeds the selected limit, stop
accepting the stale stream while preserving the replica's last fully applied
cursor, then request a fresh attachment. The host can use its existing
authoritative snapshot path to restore the latest bounded scrollback and live
screen instead of forcing the browser to parse an arbitrarily old backlog.

Recovery must preserve event ordering, never advance the resume cursor past an
unapplied event, and avoid treating ordinary configuration-only event bursts as
large output. Add focused tests for backlog accounting, threshold recovery,
reset/disconnect behavior, and successful work below the limit. Document the
bounded recovery behavior and rebuild the production web bundle.

Add a device-local Terminal output backlog setting under Settings →
Advanced → Performance. Auto follows the host's retained event window;
8, 16, and 32 MiB overrides apply immediately to open terminals and persist
only in this browser. Recovery requests a fresh snapshot so changing the limit
cannot replay the same oversized backlog repeatedly. Repeated overloads use
capped reconnect backoff without restarting or stopping the shell.

Validation:

- JavaScript syntax check and all 308 JavaScript/core tests passed.
- `go test ./...` and `go vet ./...` passed; frontend bundles rebuilt with
  `npm run build:web`.
- Regression coverage includes exact-limit accounting, partial drains,
  configuration bursts, snapshot ordering, parser errors, stale closing-socket
  messages, immediate limit changes, browser-storage refusal, and retry backoff.
- A stalled-consumer regression fed 16 MiB of output, stayed at the 4 MiB
  Auto limit, and discarded its pending drain without advancing the cursor.
- A live WebSocket smoke test streamed more than 4 MiB to a deliberately
  stalled consumer. It peaked at 4,194,285 queued bytes, closed once with 4504,
  restored a fresh snapshot, and kept the same shell epoch.
- Browser smoke testing verified Auto/8/16/32 MiB selections with an open
  terminal, 32 MiB persistence after reload, and desktop/narrow-screen layouts.

Implemented host retention metadata, per-replica byte accounting, snapshot
recovery, a separate capped overload backoff, and a device-local advanced
setting. Consumed scheduler tasks release their payload references promptly.
