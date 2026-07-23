# Task 058: Bounded terminal scrollback deque

Status: complete

Remove the repeated 4 MiB scrollback copy from terminal output publication by
storing bounded output as an ordered deque of immutable chunks.

## Requirements

- Replace each managed terminal's flat scrollback byte slice with a bounded
  chunk deque.
- Keep appending ordinary PTY output proportional to the new chunk size; never
  copy the full retained scrollback merely because it reached its limit.
- Preserve the current 4 MiB default limit and the existing meaning of a
  non-positive limit as unbounded retention.
- Retain exactly the newest `limit` bytes, including partial trimming of the
  oldest chunk and input chunks larger than the entire limit.
- Preserve byte order and exact replay content when a browser subscribes.
- Allocate a contiguous replay snapshot only when a subscriber attaches.
- Preserve immediate live publication, mouse-mode tracking, session locking,
  and slow-subscriber behavior.
- Keep retained chunks immutable after publication so PTY read-buffer reuse
  cannot corrupt replay or live output.

## Verification

- Add focused tests for below-limit appends, boundary crossing, repeated
  appends at capacity, partial front trimming, oversized chunks, and unbounded
  retention.
- Preserve the existing replay/subscription and terminal manager tests.
- Add a benchmark for sustained append behavior at the 4 MiB limit.
- Run `go test ./internal/terminal`, `go test ./...`, and `git diff --check`.

## Implementation

- Added `scrollbackBuffer`, an ordered chunk deque that evicts whole chunks or
  trims only the oldest retained chunk when crossing the byte limit.
- Kept PTY output chunks immutable by cloning the reusable read buffer once,
  then sharing that owned chunk with scrollback and live subscribers.
- Moved contiguous scrollback allocation to subscriber attachment via
  `replay`, avoiding retained-buffer copies during sustained output.
- Added focused exact-content tests and a steady-state 4 MiB append benchmark.

## Results

- `go test ./internal/terminal`: pass
- `go test ./...`: pass
- `git diff --check`: pass (Git reports only the repository's expected
  LF-to-CRLF working-tree warnings)
- `BenchmarkScrollbackAppendAtLimit` (`10000x`): 9.750 ns/op, 6 B/op,
  0 allocs/op
- `go test -race ./internal/terminal`: unavailable in the current Windows
  environment because the Go race detector requires CGO and CGO is disabled
