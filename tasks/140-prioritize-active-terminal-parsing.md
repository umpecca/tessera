# Prioritize active terminal parsing

Status: complete

## Request

Give the active terminal more parsing priority within the shared browser budget.

## Implementation

- Grant the active visible terminal three complete events per visit and other
  ready terminals one, preserving each stream's FIFO and the shared 64 KiB /
  approximately 5 ms turn limit.
- Preserve the remaining visit across yields so expensive active events cannot
  starve other panes. Promote newly ready active output once before requiring
  background progress, and transfer priority immediately on focus changes.
- Remove priority on hiding, minimizing, full coverage, deselection, or disposal;
  preserve it through a reset of the active terminal's stream.

## Validation

- All 417 JavaScript/core tests passed, including 11 new regressions for
  weighted visits, shared byte/time limits, costly active events, fresh output,
  repeated activation, output arriving during and between turns, focus changes,
  reset/disposal, visibility, and applied replica cursors.
- A headless Chrome comparison processed 16 MiB through four actual WASM
  replicas in each of three equal-priority/active-priority pairs. Every final
  screen, history, cursor, sequence, and output backlog matched the reference.
- The active pane's median completion time fell from 366 ms to 182 ms. At its
  completion, every background pane had applied 170 of its 512 events, then
  completed normally. Median aggregate throughput stayed similar at 43.7 MiB/s
  before and 43.6 MiB/s after. Every measured turn stayed within 64 KiB and
  below 3 ms. The probe measures parsing and scheduling, excluding canvas
  painting and network transport.
- Browser timing varied: the first priority sample had a 71.6 ms maximum
  animation-frame gap despite measured parsing turns below 2.8 ms; the other
  two priority samples had 19.4–19.9 ms maximum gaps. These measurements do not
  establish end-to-end rendering latency.
- `go test ./...`, `go vet ./...`, `npm run build:web`, JavaScript syntax checks,
  and `git diff --check` passed.

The existing cooperative limits still apply between complete events. A single
large parser write or snapshot import can exceed the turn budget.
