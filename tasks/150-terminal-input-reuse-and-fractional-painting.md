# Reuse browser terminal input and support fractional pixel painting

Status: complete.

## Request

Implement the next two terminal improvements: bounded browser WASM input-buffer
reuse and incremental image painting at fractional display scaling.

## Requirements

- Reuse a lazy bounded input allocation per browser terminal across writes,
  reset, and snapshot restore. Release it on disposal and use temporary buffers
  for oversized or reentrant writes. Preserve parser, responses, and lifecycle.
- Align terminal cell rectangles and image/selection/cursor/damage boundaries
  to physical pixels. Support 125%/150% and other fractional scaling without
  repeatedly darkening row edges or forcing unnecessary full redraws.
- Round native canvas size comparisons consistently, including odd grid sizes.
- Preserve integer-scale rendering and validate fractional incremental paints
  against fresh full redraws in both renderer modes. Measure both improvements.

## Implementation

- `TerminalInputBuffer` attaches to the native buffer's input method while
  retaining the existing terminal write adapter and its response handling. The
  allocation starts at 8 KiB, grows geometrically to 64 KiB, survives resets and
  imported handles, and is released on disposal. Oversized and nested writes
  use temporary input. Borrowed native views are copied before memory growth.
- The canvas wrapper rounds rectangle endpoints, image destinations, and
  damage clips to physical pixels. Horizontal decorations use integer physical
  thickness and matching centers; text retains its logical font coordinates.
- Fractional plain and image paints use the existing ordered damage-row and
  source-neighbor pipeline. Integer grids retain their ordinary path. Full
  paints still cover scrolling, scrollbar transitions, image changes, native
  invalidation, and error recovery.
- A checked build transform rounds pinned upstream canvas allocation and size
  comparisons together, including initial background coverage. It fails when
  the expected sizing expressions change and leaves installed sources intact.

## Validation

- 499 JavaScript/core/clipboard tests passed, including bounded reuse, borrowed
  views, nested and failed writes, reset/snapshot handling, parser equivalence,
  physical boundaries, decorations, method restoration, and fractional damage.
- Real Chrome verified 88 states in both Stable and Experimental renderers at
  1x, 1.1x, 1.25x, 1.5x, 1.75x, and 2x: 1,056 incremental/full comparisons.
  Integer canvases matched the previous bundle. Fractional canvases matched
  their own full redraws. Coverage includes ordinary/styled/grapheme output,
  links, cursor, selection, transparent images, placeholders/eviction, history,
  alternate screens, odd 81x25 geometry, reset, snapshots, and memory growth.
  Readback comparisons used a consistently configured canvas context to avoid
  Chrome changing rasterization backends during repeated pixel reads.
- Fair browser paint measurements used equally visible 160x60 terminals, one
  output update per animation frame, alternating order, and three repetitions.
  Image updates at 1.25x/1.5x fell from 60 painted rows to 3 (damage and source
  neighbors). Median-of-run median paint times:

  | Renderer / scale | Before | After |
  | --- | ---: | ---: |
  | Stable / 1.25x | 14.3 ms | 1.2 ms |
  | Stable / 1.5x | 14.2 ms | 1.2 ms |
  | Experimental / 1.25x | 7.9 ms | 0.8 ms |
  | Experimental / 1.5x | 8.1 ms | 0.8 ms |

- Integer full paints stayed around 14.5/14.6 ms Stable and 7.9/7.9 ms
  Experimental. Five additional integer partial-paint control runs had medians
  1.8/1.8 ms, with identical pixels, row counts, and viewport reads.
- Input benchmarks compared identical parser output in three repetitions.
  After warmup, 75,000 64-byte writes changed from 75,000 allocations/frees to
  zero, retaining 8 KiB; median batch time for 5,000 writes was 9.6/9.3 ms.
  1,500 8-KiB writes likewise eliminated per-write input allocations. 70,000-byte
  writes retained no input memory and kept temporary allocation/free behavior;
  parse time was effectively unchanged. The largest measured gain is painting.
- Raw harness/results: `.cache/review/terminal-input-pixels-150/`.
- `npm run build:web`, `go vet ./...`, `git diff --check`, and the Windows
  executable build succeeded. Native WASM bytes and core identity are unchanged.

- The complete Go suite passed using a temporary `-overlay` fixture that gives
  the persisted-HTTPS test an ephemeral HTTP port. The original fixed-port run
  failed because the user's running Tessera already occupies 7331. Repository
  test source and the running server were left intact.
