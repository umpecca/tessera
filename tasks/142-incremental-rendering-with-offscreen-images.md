# Incremental rendering with offscreen terminal images

Status: complete

## Request

Restore ordinary dirty-row painting when retained Sixel images are outside
the visible viewport. Preserve scrolling, image erasure, resizing, and layering.

## Implementation

- Use native viewport fragments to decide whether Sixel compositing requires
  a full redraw. Retained image count alone must not force full-screen painting.
- When the last visible fragment disappears, perform one clearing full redraw,
  including when browser bitmap caches were already cleared or pruned.
- Keep visible-image text/image/cursor/scrollbar ordering and explicit redraws.
- Skip image decoding and compositing for offscreen-only images, preserve cache
  cleanup, and reuse the visibility count when rendering visible fragments.

## Validation

- All 437 JavaScript/core tests passed. Seven new regressions cover offscreen
  incremental paints, explicit redraws, cache eviction, removal of the last
  visible image after cache clearing or pruning, clearing-paint retries, native
  fragment counts, overlay ordering, and terminals without images. A real WASM
  regression covers scrollback, reflow, geometry changes, alternate screens,
  image erasure, and history removal.
- Headless Chrome compared 22 painting states in each of Stable/Experimental
  renderer modes at 1× and 2× resolution. All 88 canvas hashes matched the saved
  previous bundle. Cases included small text updates, cursor visibility,
  scrollback, fractional scrolling, resizing, alternate screens, image/cache
  clearing, erasure, snapshot restoration, and terminal reset.
- Three paired Chrome measurements used a real 160-column × 60-row canvas at
  2× resolution with one retained image outside the viewport and 40 measured
  small text updates per terminal. Rows painted per update fell from 60 to 2.
  Median paint times were 32.1→1.0, 27.5→0.9, and 24.1→0.8 ms; 95th-percentile
  times were 69.6→1.6, 58.6→1.2, and 50.5→1.1 ms. Final canvases matched in every
  pair. These measurements isolate canvas painting, excluding network and
  parsing; they do not predict the improvement for full-screen output.
- `npm run build:web`, `go test ./...`, `go vet ./...`, JavaScript syntax checks,
  and `git diff --check` passed. The bundled terminal includes the change.

The browser comparison also observed existing behavior in both bundles: the
first paint after a resize with a visible image differs from the following
forced full repaint. Both stages matched the previous bundle. Reusing a WASM
instance after disposing several image-bearing terminals also produced the same
unexpected visible fragments in both bundles, so each comparison profile used
a fresh browser page. These existing cases are outside this rendering change;
the native core and snapshot format are unchanged.
