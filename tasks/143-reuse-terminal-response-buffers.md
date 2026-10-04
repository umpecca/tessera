# Reuse terminal response buffers

Status: complete

## Request

Implement performance recommendation #3: reuse the temporary 4 KiB WASM buffer
used to discard browser-side clipboard data after each terminal write.

## Implementation

- Allocate a clipboard scratch buffer lazily once per terminal and reuse it
  across writes, resets, memory growth, and same-module snapshot restoration.
- Continue draining all pending clipboard chunks and terminal query responses;
  the host remains responsible for effects and replies.
- Retain the allocating module with the pointer and release the buffer once
  during terminal disposal, before the native terminal is released.
- Leave the native core, snapshot format, and clipboard behavior unchanged.

## Validation

- All 442 JavaScript/core tests passed. Five new regressions cover full draining
  of large clipboard data and query replies, repeated small writes, lazy
  allocation, unsupported clipboard extensions, failed-read retries, disposal
  ordering and idempotence, and independent terminals sharing one module.
- The real WASM regression resumes a fragmented large clipboard sequence,
  grows module memory, resets the terminal, replaces its handle with a restored
  snapshot, and drains more clipboard data with the same scratch allocation.
- Five paired headless Chrome probes used the rebuilt and saved previous
  bundles. Each 10,000-write allocation check changed clipboard allocations
  from 10,000 to one and per-write frees from 10,000 to zero, followed by one
  free on disposal. Viewport cells, retained history, cursor state, and actual
  canvas pixels matched. Large fragmented clipboard data, query replies,
  memory growth, reset, and snapshot restoration also matched; neither browser
  emitted duplicate host replies.
- Uninstrumented browser timing alternated before/after batches after warmup.
  Median time for 100,000 one-byte writes fell from 52.6 to 44.8 ms (about 15%).
  Median time for 40,000 short ANSI progress writes fell from 79.1 to 77.0 ms
  (about 3%). These isolate browser writes and cleanup, excluding network
  transport, parsing scheduling, and canvas painting; ordinary larger writes
  should have a smaller relative benefit.
- `npm run build:web`, `go test ./...`, `go vet ./...`, JavaScript syntax checks,
  and `git diff --check` passed. The rebuilt terminal bundle includes the change.

The scratch allocation retains 4 KiB per used terminal until disposal. Idle
terminals that never write allocate no scratch space. The native core and
snapshot format are unchanged.
