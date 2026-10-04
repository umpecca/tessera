# Reuse host terminal WASM buffers

Status: complete

## Request

Implement terminal performance recommendation #1: reuse the host-side WASM
input and response scratch buffers instead of allocating and freeing them for
every PTY output chunk.

## Implementation

- Lazily retain an input buffer per core, growing up to 64 KiB. Larger writes
  use temporary allocations so exceptional output cannot inflate retained
  scratch space indefinitely.
- Share a lazily allocated 4 KiB response buffer between query and clipboard
  drains, which already execute serially under the session mutex.
- Read current module memory for every access, preserve complete effects and
  parser continuation, return owned Go bytes, and release buffers on core close.
- Preserve allocation/read error handling, bounded ownership, and idempotent
  cleanup. Keep the core artifact, protocol, and background-pane behavior.

## Validation

- Seven new Go regressions use the real core to cover repeated output/effects,
  owned response bytes, buffer growth and bounded oversized writes, memory
  growth, resize, snapshots during fragmented OSC input, large multi-chunk
  replies and clipboard data, independent modules, idempotent close, allocation
  failures, invalid read lengths, and failed-write/read retries. Exported-call
  observation confirms two lazy allocations across 129 ordinary writes/drains,
  no per-write frees, and one free for each retained buffer at close.
- Added `BenchmarkCoreHostOutput` for the actual host path: input parsing,
  query-response draining, and clipboard draining. Saved pre-change and updated
  Go test executables ran seven pairs of 10,000 iterations per workload,
  alternating execution order on this Windows amd64 / Intel i7-8850H host.

  | Workload | Before median | After median | Go allocations/chunk |
  | --- | ---: | ---: | ---: |
  | Short ANSI progress | 3,839 ns | 3,214 ns | 18 -> 6 |
  | Build output, 8,432 bytes | 459,981 ns | 455,586 ns | 18 -> 6 |
  | Query and clipboard effects | 5,132 ns | 4,490 ns | 26 -> 14 |

  Short progress processing took about 16% less time and the effect workload
  about 13% less. Bulk output was roughly unchanged (about 1% less median time).
  All workloads removed 12 Go allocations and about 143 transient Go bytes per
  chunk. These benchmarks isolate the host core, excluding PTY reads, delivery,
  browser parsing, painting, and compilation; they do not measure build speed.
  Probe binaries and raw measurements remain under the ignored
  `.cache/review/terminal-host-buffers-145/` directory.
- `go test ./...`, `go vet ./...`, a host executable build, all 20 JavaScript
  core tests, formatting, and diff checks passed. The existing Go-to-JavaScript
  snapshot interoperability and real PTY/WebSocket delivery tests also passed.
- The WASM artifact and SHA-256 compatibility identifier remain unchanged:
  `e21dfe032b17e6c132f04203149728aceda6811f63f99c1a1d10a1265ea4afcb`.

Normal PTY reads retain 12 KiB of scratch space per used core, growing to at
most 68 KiB for larger direct writes. Idle cores allocate neither buffer until
its first use. The host must be restarted with the updated build to use this
change; no browser bundle rebuild is required.
