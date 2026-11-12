# Task 258: Bounded terminal glyph caching

Status: complete, measurement-only (2026-11-11). Glyph caching rejected;
no production renderer or generated bundle changes retained.

## Request

Investigate and implement terminal glyph caching to reduce repeated text drawing,
measuring benefits and regressions while preserving rendering correctness.

## Scope

- Audit existing stable/experimental rendering and caches before adding work.
- Reuse glyph pixels only where browser measurements justify the change; keep
  conservative fallbacks for unsupported text, transforms or rendering states.
- Bound cache memory and invalidate/release on relevant font, scale, color,
  lifecycle and configuration changes.
- Preserve Unicode/emoji, styles, selection/search/links, cursor, images and
  existing smooth-scroll/dirty-row behavior. No terminal protocol/core changes.
- Add unit and actual-browser pixel/performance coverage, reporting cold/warm
  behavior and regressions rather than assuming an improvement.
- Update product docs/changelog if a user-visible change is retained and extend
  the combined checklist. Live remote-server/iPad checks remain deferred.
- Approval: the user directed implementation (“lets do it”) after the concrete
  glyph-cache scope, measurement, correctness and memory bounds were described.

## Acceptance criteria

- [x] Existing text rendering/caching is audited and the chosen scope documented.
- [x] Retained caching has a strict memory bound and correct invalidation/lifetime.
  No production cache is retained; the local prototype budget/reset/release checks
  are explicitly verified rather than claiming a bound on browser/driver memory.
- [x] Automated/browser checks preserve supported pixels, styles and interactions;
  unsupported cases retain the existing rendering path.
- [x] Browser benchmarks compare baseline with cold/warm cached workloads and
  record measured benefits, regressions and limits; unhelpful caching is not shipped.
- [x] Relevant checks pass and documentation/manual acceptance reflect the result.

## Verification

- `node --check scripts/benchmark-terminal-glyphs.mjs`: passed.
- `node --test web/*.test.mjs`: **998 passed**, including existing terminal
  rendering/selection/cursor/Unicode/image/scroll regressions.
- `npm run build:web`, `go test ./...` and `git diff --check`: passed.
- New script/task whitespace checks: passed.
- Three browser samples of all twelve configurations passed the diagnostic
  harness assertions in **Chromium 158.0.8127.18** and desktop **WebKit 27.2**.
  This means the experiment ran and bounds/fallback/opaque checks passed, NOT
  that transparent pixels matched: that prototype failed the exact-pixel goal.
- Explicit checks: no atlas use or pixel differences for fractional-grid fallback;
  exact opaque uniform-background pixels; backing-budget enforcement, capacity
  replacement, font/theme/DPR invalidation and zero retained atlas bytes on disposal.
- Production bundle was saved before this task and compared byte-for-byte after
  the build: unchanged, SHA-256
  `7b67f1ac9e71ff36db8a262a916aaf65eea9990bd6314c0dc08aa1516790f7c5`.
- No production glyph cache exists to interact with task 255 scrolling, cursor,
  selection or images. Their existing paths/tests are retained; no new browser
  proof of all interactions or physical iPad speedup is claimed.

## Implementation notes

- Created before implementation. Auditing source modules, not generated vendor JS.
- Audit: stable mode uses Ghostty's background-first `renderLine` and per-cell
  `renderCellText`; Experimental uses `terminal-plain-renderer.mjs` to merge
  backgrounds and reduce state changes, still with one `fillText` per ASCII glyph.
  Neither has a JavaScript glyph atlas. Existing task 255 caches scroll pixels,
  not glyphs. Browsers may already cache font rasterization internally.
- Task 192 previously measured low echo-frame costs and identified per-cell text
  drawing as the remaining paint cost, not a demonstrated user bottleneck.
- Added `scripts/benchmark-terminal-glyphs.mjs`: local, unshipped prototypes wrap
  only each benchmark renderer/context. A lazy transparent atlas preserves draw
  ordering; an opaque-background alternative is restricted to uniform backgrounds.
  Eligibility/transform checks are per row, not a new `getTransform` per glyph.
  Unsupported rows, decorations, Unicode and fractional grids retain `fillText`.
- Prototype backing storage is capped at 4 MiB per renderer with clear-on-full
  replacement; it is released by zeroing discarded canvas dimensions. This bounds
  estimated RGBA atlas pixels, not browser/driver overhead or total process memory.
- Final decision: **do not ship either atlas**. Transparent sprites cause many
  one-unit antialiasing-channel differences and substantial Chromium regressions.
  Opaque sprites match tested plain pixels but add restrictions/memory without
  a consistent worthwhile speedup across browsers and scales.
- Production terminal modules and vendor bundle remain unchanged for this task.
- Retained only the repeatable benchmark, this task record and a note in the
  combined acceptance checklist. No product changelog entry is appropriate:
  there is no user-visible renderer behavior change or new cache to announce.

## Measurement method

The tool uses the existing built terminal bundle, real WASM cells and production
Stable/Experimental renderers. Its local atlas intercepts `fillText` for eligible
plain rows; it does not patch the app's source or generated bundle. Regular ASCII
glyphs whose measured ink fits their cell are lazily rasterized per foreground.
Complex cells, selections/hover/search, non-default alpha/compositing and fractional
pixel grids use the original path. Opaque sprites additionally require the
uniform default background; they are not a general replacement for normal text.

Three independent samples per browser reverse case order and alternate painter
order. Each case runs 48 rounds, discarding the first eight for 40 warm samples.
Cold numbers are single first paints (one per independent sample), including lazy
cache creation and any initial canvas resize, not warmed microbenchmarks.
These are atlas-cold measurements; OS/browser font caches can already be warm.
Full-redraw timings exclude writes/parsing. Small-update timings batch 32
write+paint operations and include core write time to overcome WebKit's rounded
clock; they simulate a changing status/prompt row, not network keystroke latency.

Readback occurs only after timing, since `getImageData` can change the canvas
backend. Exact differences are recorded both initially and after a fresh full
repaint following readback. One-unit differences are NOT silently accepted as
pixel equality. All timings are main-thread component timings, not GPU presentation,
whole-session throughput, battery or physical-device results.

## Results (final repeated measurements)

Apple M5 Max, macOS arm64; bundled JetBrains Mono at 14 px, exposed as `ProbeMono`
in the fixture. Canvas device scale is 2 with per-terminal caps of 1, 1.25 or 2.
Numbers below are medians of each run's median, across three independent runs.

| Browser / 160×60 workload | Existing | Transparent atlas | Opaque uniform-only atlas |
| --- | --- | --- | --- |
| Chromium, Stable full redraw, DPR 1 | 5.10 ms | 10.90 ms | 5.30 ms |
| Chromium, Stable full redraw, DPR 2 | 5.30 ms | 13.30 ms | 5.40 ms |
| Chromium, Experimental full redraw, DPR 1 | 2.50 ms | 8.00 ms | 2.60 ms |
| Chromium, Experimental full redraw, DPR 2 | 2.60 ms | 10.50 ms | 2.70 ms |
| Chromium, Stable small update, DPR 2 | 0.188 ms | 0.544 ms | 0.188 ms |
| Chromium, Experimental small update, DPR 2 | 0.097 ms | 0.344 ms | 0.097 ms |
| WebKit, Stable full redraw, DPR 1 | 7.00 ms | 6.00 ms | 6.00 ms |
| WebKit, Stable full redraw, DPR 2 | 6.00 ms | 6.00 ms | 7.00 ms |
| WebKit, Experimental full redraw, DPR 1 | 3.00 ms | 3.00 ms | 3.00 ms |
| WebKit, Experimental full redraw, DPR 2 | 3.00 ms | 3.00 ms | 3.00 ms |
| WebKit, Stable small update, DPR 2 | 0.219 ms | 0.188 ms | 0.219 ms |
| WebKit, Experimental small update, DPR 2 | 0.094 ms | 0.094 ms | 0.094 ms |

Chromium DPR-2 cold full paints: Stable **5.7 → 17.8 / 5.8 ms**,
Experimental **2.8 → 13.9 / 2.9 ms** (transparent / opaque respectively).
The smaller 80×24 Stable DPR-2 case is **1.1 → 1.3 / 1.1 ms** warm.
The DPR-1.25 fallback has zero atlas hits, exact pixels and **5.9 ms** medians
in all three variants; these coarse timings do not establish zero overhead.

Transparent sprites change up to **one intensity unit** in glyph antialiasing
channels on both browsers in final runs. Chromium's final DPR-2 full grid differs
in **951,804 channels**, including after the stable readback repaint. Opaque
sprites match the tested uniform-background pixels exactly but have not shown
a consistent worthwhile timing improvement. Unicode rows remain on the original
path; regular rows elsewhere can still account for transparent differences.

Chromium stress checks use 64 foreground colors, then change font, theme and DPR:
peak atlas pixel backing **4,114,944 bytes**, below **4,194,304 bytes**; seven resets
including capacity/configuration changes; **zero retained atlas bytes** after
explicit prototype disposal. This does not measure driver/GPU memory.

WebKit reports the same stress budget/reset/release results. Its Stable DPR-2
cold full-paint medians are **6 / 6 / 6 ms**, Experimental **3 / 3 / 2 ms**.
The smaller 80×24 Stable case is **2 / 1 / 2 ms** warm; the fractional-grid case
**7 / 7 / 8 ms**. WebKit's whole-millisecond clock limits full-frame precision;
32-update batches improve small-update resolution to 1/32 ms. Small differences
are not evidence of a statistically established speedup/regression.

Thus there are isolated WebKit improvements, but not a broadly useful cache that
meets both the correctness and performance requirements. This rejects these
Canvas2D atlas implementations, not every possible future GPU/text renderer.

## Reproduction and remaining acceptance

Run `node scripts/benchmark-terminal-glyphs.mjs --playwright=<module path>
--browser=chromium --repeats=3 --output=<JSON path>` and repeat with `--browser=webkit`.
Set `PLAYWRIGHT_BROWSERS_PATH` for the available Playwright browser installation.
No live server, authentication, remote desktop or personal terminal contents are used.

Raw JSON outputs under
`/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/`:

- `tessera-glyph-chromium-final.json`
- `tessera-glyph-webkit-final.json`

Corresponding `.txt` files contain per-sample output. The saved baseline bundle is
`tessera-task258-baseline-terminal.js` in the same directory. A first harness run
failed on a stress-fixture scoping error; it was fixed before the final successful
three-sample runs, with no production changes needed.

The [combined device checklist](../docs/performance-acceptance.md) adds optional
real-iPad paint observations to identify an actual bottleneck before revisiting
text caching. Existing task 254–257 live checks remain deferred as requested.
There is no new glyph-cache behavior requiring live acceptance. No commits/pushes.
