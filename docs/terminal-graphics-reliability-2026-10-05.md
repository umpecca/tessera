# Terminal graphics investigation — 2026-10-05

The final change repairs application recovery after canvas context loss. CPU
backing was evaluated and rejected as a default. The original silent corruption
and Chrome graphics stalls remain unresolved; this is not a release clearance.

The [follow-up isolation](terminal-graphics-isolation-2026-10-05.md) locates the
original corrupt region below the test viewport, separates CPU time from long
GPU-thread wall time, and compares browser-only drawing with intrusive and
less intrusive trace controls. It does not establish a repair for either
remaining failure.

## Starting evidence

The task 155 native page initialization repair remains in place. Its visible
ten-minute test drained approximately 2.23 GiB without native traps. The
experimental renderer passed all 18 pixel checks. One classic full-paint check
contained 30 severely corrupt pixels in an 8×4 region, including random alpha
and bright purple channels. Separately, four echoes shared one delayed frame;
the largest delay was 311.6 ms. The trace showed a 360.433 ms
`DXGISwapChainImageBacking::Present` call on Chrome's GPU thread. Those are
different failures; a clean canvas does not prove timely presentation.

The software-browser control passed all 24 exact pixel checks, but globally
disabling browser GPU acceleration was only a diagnostic control.

## Research and candidates

Chromium explicitly selects CPU rasterization when a 2D canvas requests
`willReadFrequently: true`. This setting applies to that canvas and leaves
browser compositing available. See Chromium's
[canvas allocation policy](https://chromium.googlesource.com/chromium/src/third_party/+/refs/heads/main/blink/renderer/core/html/canvas/html_canvas_element.cc)
and [canvas tests](https://chromium.googlesource.com/chromium/src/+/b18360daa9b9ddbebd775cdc2fc81642afb66220/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d_test.cc).

Tested private bundles against the saved task 155 bundle:

- Transparent CPU main canvas: classic text checks passed, but the small image
  case failed strict stable-context validation with one-level glyph differences.
- Opaque CPU canvas: rejected because text acquired colored subpixel edges and
  a repeat-paint mismatch of up to six color levels.
- Transparent CPU main and image canvases: all 20 paint cases passed with exact
  pixels. They cover both renderers, full/partial output, images, Unicode, and
  125%/200% rendering ratios, including a 15 px font with fractional boundaries.

A standalone Chrome reproduction, without Tessera, explains the first
candidate's additional failure: drawing a GPU-backed source canvas into a
CPU-backed destination changed glyph rounding between the first and second
identical paints. Subsequent paints matched. Giving the source canvas CPU
backing too made every comparison exact. This is an observed browser behavior;
it does not establish the cause of the earlier severe corruption.

Rejected `desynchronized` as a default workaround. Its direct presentation
path has overlap and tearing constraints that conflict with overlapping
terminal windows. Context creation attributes must also be selected on the
first `getContext()` call. See Chrome's
[low-latency canvas guidance](https://developer.chrome.com/blog/desynchronized).

## Initial paired painting measurements

Default hardware Chrome, visible browser, bundled JetBrains Mono 14 px.
Readback follows timing. Numbers below are mean per-run paint medians, rather
than GPU completion or physical display latency.

| Viewport / renderer / ratio | Samples | Saved bundle | CPU candidate |
| --- | ---: | ---: | ---: |
| 160×60 classic / 1.25 | 3 | 17.667 ms | 17.567 ms |
| 160×60 classic / 2 | 3 | 17.033 ms | 17.267 ms |
| 80×24 experimental / 1.25 | 1 | 2.300 ms | 2.300 ms |
| 80×24 experimental / 2 | 1 | 2.200 ms | 2.200 ms |
| 160×60 experimental / 1.25 | 1 | 9.700 ms | 9.800 ms |
| 160×60 experimental / 2 | 1 | 9.500 ms | 9.600 ms |

These short measurements show similar JavaScript painting costs. They do not
establish sustained presentation performance. The longer controls below show
why the CPU candidate was rejected despite these initial results.

## Canvas recovery

The adapter now listens for `contextlost` and `contextrestored`. While lost it
continues accepting terminal data, retains a full redraw request, and avoids
acknowledging output as painted. It also checks loss before the event arrives
and after a paint. Restoration rebuilds drawing state and the DPR transform,
invalidates derived image bitmaps, and repaints retained text/images without
replacing the native terminal. Disposal removes the listeners.

This follows Chrome's
[canvas context recovery guidance](https://developer.chrome.com/blog/canvas2d/#context-loss).
The 2D loss event is left uncanceled, preserving automatic restoration.

The unit regression covers loss before notification, output during loss,
restoration without fresh output, loss during painting, return to incremental
painting, and listener cleanup. Browser controls reset the real bitmap/state
and dispatch simulated loss/restoration events. Both renderers at 1.25 and 2
match an uninterrupted reference exactly, including Unicode and recreated
images. These controls test application recovery; they do not induce a real
driver reset or prove recovery from termination of the entire browser process.

An additional real GPU-process restart control passed twice, including the
checked-in `scripts/terminal-benchmark/gpu-recovery.mjs` runner. Each uses its own
temporary, visible Chrome and `Browser.crashGpuProcess` through that browser's
CDP connection. Both renderers received trusted loss/restoration events. Output
written during the outage survived, the native handles remained unchanged,
old image canvases were released, and the first recovered paint was full.
Recreated images and glyphs were present in actual pixels, with no page errors.
This verifies automatic recovery from Chrome GPU-process loss; it still does
not restart the graphics driver or recover a terminated browser tab.

## Final checks

- All 513 final JavaScript tests passed. The exploratory CPU policy's three
  extra tests were removed with that rejected policy; its earlier suite had
  516 passing tests.
- Go tests passed using the existing ephemeral-port test overlay, plus Go vet
  and the executable build.
- The web bundle rebuilt successfully; host/browser native core remains
  `c08061da69e1d6157e5eb2bc6314991c47283b14aaa00618d92d4478fa33b25f`.
- Packaged smoke checks passed at 125% and 150% DPI: three terminals, UTF-8
  typing/output, reload, and six matching-core attachments, with no page errors.
  Navigation intentionally aborted two activation requests in each check.
- Final quick visible run: all output drained, 160 terminal creations/disposals,
  four exact recovery controls, and 24 exact paint checks, with the original
  browser canvas allocation policy. No page errors occurred.
- Final bundle:
  `2620caa0108dd6d874ac2e567aea14468287231db0827ef9857d1fb7de877dba`.
- A final untraced 30 s paired control at 2 MiB/s, four 160×60 experimental
  panes, drained completely for both builds with no long JavaScript tasks.
  Saved/final median echoes were 18.5/18.3 ms, p95 23.5/21.3 ms, and worst
  53.7/50.7 ms. These are within this paired run; do not compare absolute
  numbers to earlier intervals as if browser/driver scheduling were fixed.

## Sustained CPU candidate

Normal GPU compositing remained enabled in visible Chrome 154.0.8037.95 on
Intel UHD 630 / ANGLE D3D11. The candidate bundle was
`8ab03761e76c42c029516d82161994d56961c5e13a26132da67a8f0bc7b4ac99`.

| Phase | Duration | Echoes | Median | p95 | Worst |
| --- | ---: | ---: | ---: | ---: | ---: |
| Four large experimental panes, 2 MiB/s | 240 s | 4,141 | 3.0 ms | 19.3 ms | 490.4 ms |
| Four large classic panes, 2 MiB/s | 180 s | 3,257 | 27.1 ms | 28.8 ms | 484.7 ms |
| Eight experimental panes, 8 MiB/s | 180 s | 3,104 | 5.2 ms | 12.9 ms | 427.6 ms |

All 2,390,674,368 output bytes drained; no native errors occurred. The following
160-terminal lifecycle, four recovery controls, and all 24 exact pixel checks
passed. This establishes correctness in this run, not a presentation-latency
repair.

Unlike the saved build's captured `Present` stall, these first-stall traces
contain long GPU raster-command processing: `CommandBufferService:PutChanged`
lasted 497.053 ms for experimental, 472.737 ms for classic, and 477.390 ms for
eight-pane stress. Corresponding renderer-main tasks were much shorter. The
original stalls precede trace extraction. Extraction itself took approximately
0.85–12.1 s and can disturb later timing; stalls also continued after extraction.
Do not attribute every outlier in this instrumented run to ordinary usage.

## Untraced comparison and final decision

Alternated saved build / CPU candidate / CPU candidate / saved build in one
visible browser, using fresh pages, four 160×60 experimental panes at ratio
1.25, 2 MiB/s, and 60 s per interval. No trace or canvas readback ran during
timing. The native core was identical in both bundles.

| Interval | Build | Median echo | p95 echo | Worst echo |
| --- | --- | ---: | ---: | ---: |
| 1 | Saved GPU policy | 5.1 ms | 8.8 ms | 29.0 ms |
| 2 | CPU candidate | 3.4 ms | 19.5 ms | 26.6 ms |
| 3 | CPU candidate | 3.8 ms | 20.3 ms | 472.7 ms |
| 4 | Saved GPU policy | 4.9 ms | 8.8 ms | 372.5 ms |

Every interval drained completely, with no long JavaScript tasks. Stalls occur
without tracing and are not exclusive to the classic renderer. The CPU
candidate improves the median, but roughly doubles p95 and fails to eliminate
stalls. Its clean pixels on this machine do not justify applying this tradeoff
to every Windows Chromium installation. The product therefore retains its
original canvas allocation and image backing policy. No CPU-default patch,
opaque-canvas change, or low-latency canvas flag is included.

Keep the canvas recovery repair: its unit, synthetic browser, and real
GPU-process restart controls passed. It addresses blank/lost canvas recovery,
not unreported corruption or a blocked graphics thread. The original severe
corruption needs a stronger isolated reproduction, and the remaining graphics
stalls need browser/driver investigation. Hold the tag if these are release
blockers. No native core changes were needed in this task.

Artifacts: `.cache/review/terminal-graphics-156/` contains candidate bundles,
environment metadata, paint/load results, three rolling traces, trace summaries,
recovery results, screenshots, packaged smoke results, and check logs. The live
host, its terminals, and browser-wide graphics settings have not been changed.

To repeat the real GPU-process recovery control, use a configured Playwright
module and browser executable:

```text
node scripts/terminal-benchmark/gpu-recovery.mjs --playwright=<module> --chrome=<executable> --output=<directory>
```

The runner always launches its own temporary browser. It intentionally restarts
only that browser's GPU process and closes its own fixtures afterward. No
connection to an existing browser or the live Tessera host is used.
