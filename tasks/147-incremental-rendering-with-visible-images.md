# Task 147: Incremental rendering with visible terminal images

Status: complete.

## Request

Implement the next terminal performance improvement: preserve dirty-row painting
while Sixel images remain visible.

## Requirements

- Repaint image fragments only on rows repainted by the text renderer.
- Preserve transparency, overlapping image order, selection, cursor, and scrollbar
  layering without accumulating image opacity on unchanged rows.
- Preserve full redraws for scrolling, resizing, image changes, and recovery.
- Keep cache cleanup and last-visible-image clearing intact.
- Validate both terminal renderers with real browser canvas comparisons and measure
  paint work for small updates while images remain visible.

## Validation

- All 468 JavaScript/core/clipboard extension tests passed, including nine new
  image-rendering regressions. Coverage includes actual native fragment filtering,
  idle allocation avoidance, ordered and clipped neighboring glyph paints,
  selection coordinates, clean-row cursor visibility/shape changes, scrollbar
  removal, explicit/cache/native/viewport invalidations, fractional pixel edges,
  method and canvas restoration after failures, and last-image clearing after a
  failed first composite.
- Headless Chrome compared 60 states in each of Stable/Experimental renderer
  modes at 1x, 2x, 1.25x, and 1.5x resolution. All 960 initial and forced-full
  canvas hashes matched the saved previous bundle. Cases include transparent
  overlapping images, dirty text on and away from image rows, complex glyph edges,
  cursor movement/blinking/shapes/DEC hide, selection and hover changes, scrollbar
  fading/removal, partial overwrites/erasure, bitmap cache clearing, real decoded
  image eviction and placeholders, resize, alternate screens, and scrollback.
- Three paired Chrome measurements used a real 160-column x 60-row canvas at 2x
  resolution with one visible image and 40 measured small text updates per
  terminal. Painted rows fell from 60 to 3 and image fragment draws from 8 to 0.
  Median paint times were 23.1->1.2, 23.0->1.2, and 23.0->1.2 ms; 95th-percentile
  times were 48.0->1.4, 47.8->1.4, and 46.8->1.3 ms. Final canvases matched in all
  pairs. These isolate canvas painting, excluding network/parsing, and do not
  predict improvements for full-screen output. Raw comparisons, measurements,
  saved baseline bundle, and harness are in the ignored
  `.cache/review/terminal-visible-image-rows-147/` directory.
- `go test ./...`, `go vet ./...`, `npm run build:web`, final host build,
  JavaScript syntax checks, and diff checks passed. Embedded-web tests passed
  again against the final rebuilt bundle. The native WASM artifact, compatibility
  hash, and snapshot schema are unchanged.

## Implementation and limits

Partial image frames collect the base renderer's dirty, selection, hover, and
cursor rows, then paint text once in row order under a damage clip. Neighboring
source rows preserve glyph ink across row boundaries. Only image fragments and
selection overlays in the repainted region are composited, followed by the cursor
and scrollbar. Unchanged transparent image pixels and cursors are not composited
again. A failed paint forces a complete retry even if native dirty flags were
already cleared.

Normal full frames keep streaming one text row at a time. Scrolling, resizing,
image/native invalidation, cache clearing, visible scrollbar frames and their
removal, and recovery retain full redraws. Fractional device-pixel row heights
also retain full paints: the prior renderer blends row edges with existing canvas
pixels, so partial painting cannot reproduce its boundary pixels reliably. This
depends on font metrics as well as display scaling. The browser harness observed
the same first-versus-forced-full differences at fractional scaling in both
bundles; these existing rasterization differences are outside this change.

The rebuilt host is `bin/tessera.exe`. Restart the updated host and refresh the
browser to load the new embedded terminal bundle.
