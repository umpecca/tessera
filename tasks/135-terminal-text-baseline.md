# Task 135: Terminal text baseline

Status: complete

Correct the high text alignment visible in the Fresh terminal editor. Ghostty
Web measures a capital M's ink bounds, which omit accents and descenders and
place ordinary text near the top of the cell.

## Requirements

- Measure full font ascent and descent when the browser provides them; use a
  representative accented/descending glyph sample on older browsers.
- Keep character widths and horizontal placement intact. Share one set of
  metrics across normal, experimental, selected, and styled text, cursors,
  mouse coordinates, and terminal fitting.
- Apply the measurements on startup and after font family or size changes.
- Keep the fix in Tessera's adapter and rebuild the bundled terminal renderer.

## Validation

Verify the actual pinned renderer, older-browser measurement fallbacks, font
changes, and consistent baseline placement across normal and experimental
rendering. Compare browser output for all three bundled fonts, including
accented letters and descenders, and run the frontend suites and web build.

## Implementation and validation

The adapter overrides the pinned renderer's font measurement before terminals
open. It retains the capital M's advance width and uses the maximum full font
and sampled glyph bounds from regular and bold faces for vertical metrics.
Accented glyphs can exceed a font's reported bounds, so both measurements are
needed. Older browsers use sample ink bounds and retain numeric fallbacks.
All existing rendering paths and geometry consumers share these metrics.

At 14px, JetBrains Mono's cell height changes from 16px to 20px and its baseline
from 12px to 15px. The before-and-after browser comparison confirms balanced
text placement and room for accents. Browser checks pass for all 90 combinations
of the three bundled fonts, 10–24px sizes, and regular/bold weights. The preview
also exercises experimental rendering on the final row.

All 381 frontend/core/build-guard tests pass, including nine new regressions
against the actual pinned renderer. The web build, web Go tests, JavaScript
syntax checks, and whitespace checks pass. Fresh itself and older browser
engines were not exercised live; the older-browser fallback is covered by tests.

The Go application build also passes. The existing server on port 7331 serves
an older embedded terminal bundle; it was left running to preserve its live
PTY sessions. Loading this change requires restarting with the rebuilt app or
running `go run ./cmd/tessera` against the updated source.
