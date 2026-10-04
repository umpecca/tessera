# Task 139: Share terminal parsing turns and count live output bytes

Status: complete

Apply the terminal write scheduler's output-byte budget to live replica events.
Share one 64 KiB / approximately 5 ms parsing turn across browser terminals
instead of allowing each visible pane an independent turn. Rotate complete
events between ready panes while preserving each pane's FIFO and applied
resume cursor. Include resize, configuration, image, clipboard, and snapshot
tasks in scheduling without charging them to the output-byte budget.

Reset, hiding, reconnect, disposal, and parser failure must release only that
pane's pending work. Keep other terminals running and prevent a busy pane or
an expensive event from starving its siblings. Events and snapshot imports
remain atomic, so the time/byte limits are cooperative between complete tasks.

Validate byte accounting through the actual replica path, round-robin fairness,
shared time limits, lifecycle cancellation, mixed event ordering, and sustained
output. Compare the old and new scheduler behavior, run the complete browser
and Go checks, rebuild web assets, and document the resulting behavior.

Implemented a default shared coordinator and pane-local FIFO queues. Live
replica tasks now supply their byte count; each turn rotates complete events
between ready panes and checks the aggregate byte and time budgets. Queue
reset, hidden-pane suspension, parser failure, and disposal leave sibling
queues intact. The applied replica cursor still advances only after a complete
event or snapshot import.

Use posted MessageChannel tasks for production turns, with cancellation tokens
and a timer fallback. This avoids the nested-timer delay that otherwise reduced
sustained throughput when yielding more frequently. Tests inject their own
coordinator clocks and callbacks.

Validation results:

- All 406 JavaScript/core tests passed, including 12 new regressions covering
  live byte accounting, shared time limits, fairness, mixed event ordering,
  canceling posted messages, parser errors, atomic oversized events, and
  independent backlog recovery. Existing hidden-pane regressions still pass.
- A 1 MiB replica queue now applies 64 KiB in its first turn, leaving the
  remaining 960 KiB queued and advancing the cursor by exactly eight complete
  8 KiB events. The previous path applied the entire 1 MiB when the test clock
  did not reach its time limit.
- A headless Chrome probe processed 16 MiB through four real WASM terminal
  replicas in each of three before/after runs. Every terminal finished with
  matching screen cells, retained history, cursor, sequence, and zero backlog.
- The browser probe's 95th-percentile timer interval fell from 25.3–25.6 ms
  to 4.4 ms. Its maximum animation-frame gap fell from 46.6–50.2 ms to
  32.5–33.9 ms. Parser throughput stayed similar: 40.1–45.1 MiB/s before and
  43.4–44.0 MiB/s after. These are isolated parser/scheduler measurements,
  excluding canvas painting and network transport.
- `go test ./...`, `go vet ./...`, and `npm run build:web` passed.
- JavaScript syntax and `git diff --check` passed.

The time and byte budgets apply between complete events; they cannot interrupt
an expensive parser write or snapshot import midway through an event.
