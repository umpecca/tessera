# Task 255: Cache terminal smooth-scroll painting

Status: implementation and automated verification complete (2026-11-11);
physical-device acceptance deferred to the combined testing block.

## Request

Reduce repeated full-terminal rasterization during smooth scrollback scrolling.
Keep live acceptance together with task 254's RDP checks so the user can test
both optimizations in one dedicated block.

## Scope

- Reuse bounded rendered text pixels across eligible smooth-scroll frames,
  including row movement where it can preserve exact physical-pixel alignment.
- Preserve scrolling distance/easing, history content, hit testing, scrollbar
  coordinates, live output and terminal state.
- Invalidate cached content on output, core/geometry/font/theme changes and
  canvas loss/recovery; release backing storage on disposal or leaving the path.
- Use the existing full renderer for images and overlays or pixel grids that
  cannot safely reuse rasterized content. Correctness takes precedence over
  extending the optimization to every case.
- Add regression coverage and browser pixel/performance checks where available;
  distinguish component measurements from real-device performance claims.
- Maintain a combined manual acceptance checklist for terminal scrolling and RDP
  presentation backpressure. No other optimization-list items belong here.
- Approval: the user requested proceeding with terminal smooth-scroll caching
  and deferring hands-on validation to one testing block.

## Acceptance criteria

- [x] Eligible smooth-scroll frames reuse pixels instead of rasterizing every
  visible text row; cache storage remains bounded per pane.
- [x] Cached and full-rendered output match through fractional motion, row
  crossings, reversals, boundaries and cache invalidation.
- [x] Images, selection, search/hover decorations and unsupported geometry keep
  correct rendering through explicit conservative fallback.
- [x] Input hit testing, scroll animation, live history and terminal lifecycle
  behavior remain unchanged; failures cannot leave stale cache pixels in use.
- [x] Relevant tests/build checks and measured results are recorded honestly.
- [x] A single manual checklist covers this task and task 254's live acceptance.

## Verification

- Deterministic renderer and terminal-lifecycle tests for reuse, invalidation,
  fallback, cleanup, and rendering failures.
- Browser checks with the bundled core: exact cached/full pixels at representative
  scale factors and workloads; paired timings outside pixel readback.
- Full JavaScript tests, relevant Go checks, web build and whitespace checks.
- Real iPad/Remotr acceptance is deferred, not assumed to have passed.

## Implementation notes

- `web/terminal-scroll.mjs`: one viewport-plus-top-row backing per eligible pane,
  capped at 32 MiB of RGBA pixel storage. Integral history positions and unsupported
  states retain the existing renderer. Native dirty state, core identity/history,
  geometry, metrics, font, theme and forced redraws invalidate reuse.
- Same-anchor fractional motion reuses body pixels and repaints only the final
  clip-edge row, using retained decoded cells rather than another native read.
  This preserves exact font rasterization at the real canvas boundary.
- Safe row crossings shift backing pixels and repaint clipped boundary bands plus
  neighboring glyph sources. Temporary native-read filters skip unchanged middle
  rows and are restored, along with context/renderer methods, even on failure.
- Complex graphemes are a measured correctness boundary: Ghostty resolves their
  strings by viewport row. They retain same-anchor reuse, but crossings repaint
  fully. Newly exposed graphemes discard a provisional edge paint before display.
- `web/terminal-entry.js`: explicit redraw, hidden panes/pages, context loss and
  disposal release backing pixels. The core, scroll easing and hit testing are
  unchanged. Image and selection/search/hover paths use conservative fallback.
- `scripts/benchmark-terminal-browser.mjs --group=scroll` and its browser harness
  add cached/full pixel comparisons and paired timings against a saved pre-change
  terminal bundle. Readback is outside timing; row counts and backing bytes are
  recorded separately. Stable CPU readback contexts are correctness oracles, not
  the timed presentation contexts.
- Added `docs/performance-acceptance.md` as the single later hands-on block for
  this task and task 254. Updated terminal documentation and the changelog.

## Automated verification

- `node --test web/*.test.mjs`: **995 tests passed** on the final code.
- `go test ./...`: passed, including embedded-module checks.
- `go vet ./...`, `npm run build:web` and whitespace checks: passed. New task
  and checklist files were checked with `git diff --no-index --check` as well.
- Targeted renderer/core/lifecycle tests cover allocation failure, cleanup,
  context recovery, invalidation, native read-filter restoration and newly
  exposed graphemes. Existing animation and hit-testing tests remain unchanged.
- Chromium **158.0.8127.18**, headless on **Apple M5 Max**: 33 configurations ×
  3 repetitions, **99 runs / 1,980 exact cached-vs-full pixel comparisons**.
  Coverage: 80×24 and 160×60, Stable/Experimental, ASCII/styled Unicode, render
  ratios 1/1.25/1.5/2 and one 15px-font case. Unaligned grids exercise fallback.
- Final Chromium 160×60 / 2× / Experimental checks add **60 exact comparisons**,
  including transitions through selection, search, hovered-link decoration,
  Sixel insertion/removal, output, same-grid geometry changes and program colors.
- Headless desktop WebKit 80×24 / 2× / Experimental: ASCII and styled Unicode,
  **60 exact comparisons**, including the same decoration/image transitions.
  This is desktop WebKit automation, not iPad Safari/WKWebView acceptance.
- Initial pixel failures were fixed, not tolerated: row-relative grapheme lookup
  prevents shifting complex rows, and actual canvas-edge font clipping requires
  repainting the bottom visible row directly. The final checks require exact
  equality in stable readback contexts.
- Generated `web/vendor/terminal.js` rebuilt from source. No terminal-core/WASM,
  RDP implementation or user settings changed in this task.
- Hands-on iPad/Remotr testing remains intentionally deferred to
  [the combined checklist](../docs/performance-acceptance.md).

## Component measurements and limitations

Paired timing excludes pixel readback and alternates terminal order. Each run
has 16 warmup frames and 80 measured frames, with slow fractional motion and
direction reversal. The table uses medians of three run summaries for
160×60 / 2× / Experimental. It is not end-to-end input latency or an FPS claim.

| Workload | Mean paint before → after | Median paint before → after | p95 before → after |
| --- | --- | --- | --- |
| ASCII history | 4.92 → 0.79 ms | 4.90 → 0.20 ms | 5.10 → 4.80 ms |
| Styled Unicode/graphemes | 4.59 → 1.45 ms | 4.60 → 0.10 ms | 4.90 → 9.70 ms |

- Typical cached frames paint **1 row instead of 61**. ASCII row-crossing frames
  paint 10 rows including glyph neighbors and the bottom-edge repair. Complex
  grapheme crossings rebuild all rows, then copy the backing: **their p95 is
  worse despite lower average work**. This tradeoff must be checked on devices,
  especially high-refresh displays; it is not claimed to be universally faster.
- The large 2× backing is **26,703,360 bytes (25.47 MiB)**; 80×24 / 2× uses
  **5,472,000 bytes (5.22 MiB)**. These are RGBA backing estimates, not total
  browser/GPU memory measurements. Each pane is capped at 32 MiB.
- Unsupported fractional grids retain the full renderer and show no claimed
  speedup; small timing differences in those controls remain in the raw data.
- Final expanded Chromium checks reproduced the benefit and the Unicode-tail
  tradeoff: ASCII mean 5.00 → 0.84 ms; Unicode mean 5.03 → 1.58 ms, but Unicode
  p95 5.20 → 10.50 ms. WebKit clocks are rounded to whole milliseconds; its
  small per-frame timings should not be read as sub-millisecond precision.

Raw results are in the approved session temporary directory:

- `tessera-scroll-matrix/{environment.json,scroll-results.json}`
- `tessera-scroll-final/{environment.json,scroll-results.json}`
- `tessera-scroll-webkit/{environment.json,scroll-results.json}`

Directory prefix:
`/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/`.
The saved baseline is `tessera-scroll-before.js` in the same directory. Reproduce
with `scripts/benchmark-terminal-browser.mjs --group=scroll --baseline=<path>`;
use `--browser=webkit` for the desktop WebKit check and supply the available
Playwright module/browser installation paths.
