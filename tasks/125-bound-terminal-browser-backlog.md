# Task 125: Bound terminal browser backlog

Status: proposed

Prevent sustained high-volume terminal output, such as a Linux kernel and
userspace build, from growing the browser's unapplied terminal-event queue
without limit.

Track the output bytes accepted from the WebSocket but not yet applied to the
browser terminal replica. When that backlog exceeds the host's retained
terminal-state window, stop accepting the stale stream and reconnect from the
replica's last fully applied cursor. The host can then use its existing
authoritative snapshot path to restore the latest bounded scrollback and live
screen instead of forcing the browser to parse an arbitrarily old backlog.

Recovery must preserve event ordering, never advance the resume cursor past an
unapplied event, and avoid treating ordinary configuration-only event bursts as
large output. Add focused tests for backlog accounting, threshold recovery,
reset/disconnect behavior, and successful work below the limit. Document the
bounded recovery behavior and rebuild the production web bundle.

Validation:

- Pending implementation
