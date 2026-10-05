# Terminal performance polish before the next release

Status: complete.

Later release validation in task 154 found a native memory trap after repeated
terminal reuse and image/Unicode output. Task 155 fixed it; its hardware soak
still failed on canvas corruption and a presentation stall. The optimizations
are implemented, but tagging remains on hold pending graphics investigation.
See `docs/terminal-page-initialization-2026-10-05.md` for current validation.

## Request

Implement the three approved terminal optimizations together before tagging:
skip unchanged retained-image collection, read only painted native rows, and
create browser image bitmaps only when their fragments need painting.

## Requirements

- Preserve immediate image reclamation after overwrite, erase, history eviction,
  page copies, reflow, screen changes, reset, snapshots, and budget pressure.
- Preserve full/partial paint pixels, Unicode/graphemes/styles, independent row
  copies, selection/link reads, memory growth, and failure recovery.
- Load visible image pixels on demand while keeping transparency, layering,
  placeholders, and eviction correct.
- Measure each change against the saved current core/bundle and reject changes
  that regress ordinary output or full painting.
- Rebuild and verify the pinned core and browser bundle together; run the combined
  regression suite and disposable packaged-app smoke tests. Do not tag or restart
  the user's running server as part of this task.

## Validation

- Added independent native row/page membership and mutation tracking. Ordinary
  writes retain the original parser; image tracking transfers canonical partial
  UTF-8/escape state through a specialized handler and restores it on return.
- Added one-row native reads with the pinned cell conversion/decoder. Sparse
  paints retain owned row copies; eight dirty rows and full/history paints keep
  the bulk reader. Readers restore after successful or failed paints.
- Browser bitmaps are created only for painted visible fragments, with existing
  eviction, layering, placeholders, and recovery behavior preserved.
- Final tiny native writes with one image and ~10k history lines: 72.288 →
  0.222 µs; host/wazero: ~158–161 → 0.495 µs. Representative partial paint:
  3.0 → 2.0 ms, 9,600 → 480 decoded cells. History-image first paint creates
  1 bitmap instead of 17 and uses 0.469 MiB instead of 7.969 MiB of bitmap RGBA.
- Removed an initial ordinary-parser regression by isolating the tracked
  specialization. Final ordinary build parsing measured 2.7% lower; Unicode
  and the five-repeat tiny-progress follow-up were slightly faster.
- Passed 511 JS tests, Go suite with the existing ephemeral-port test overlay,
  Go vet, six Zig tests, Windows executable build, fresh pinned-source WASM
  verification, and a byte-identical browser bundle rebuild.
- Passed the final 20-case hardware matrix, a 20-case software control, and
  packaged three-pane typing/Unicode/reload checks at 125% and 150% scaling.
  Three visible-browser four-pane load runs drained all streams and echoes;
  maximum echo latency was 34.3 ms, with no long tasks.
- Expanded release CI tests and corrected release documentation to match the
  workflow's tag trigger and enabled architectures.
- Measurements and limits: `docs/terminal-performance-2026-10-05.md`. Earlier
  intermediate hardware readback failures remain documented; these changes
  do not claim to resolve Chrome's intermittent graphics stalls/corruption.
- Left changes uncommitted and did not tag, publish, or restart the running host.
