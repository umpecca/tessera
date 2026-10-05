# Terminal performance measurements, October 4, 2026

Normal 80x24 full text paints took about 2.3 ms. Large 160x60 full paints took
9.3 ms with Experimental rendering and 15.7 ms with Stable rendering. Active
echoes usually remained responsive with several busy panes, but occasional
large frame gaps appeared. The tests also exposed reproducible native Unicode
and dense Sixel failures, subsequently fixed in task 152. Original measurements
are preserved here; the post-fix results are recorded below.

The earlier roughly 10x fractional image-paint improvement is repeatable when
the font's row height falls between physical pixels. It does not apply to every
font/scale combination: default 14 px JetBrains Mono has 20 px logical rows,
which already land on whole pixels at both 125% and 150%.

## Method and scope

- Windows Server 2025, Intel i7-8850H, 6 cores / 12 logical processors, 15.8 GiB
  RAM, Chrome 154.0.8037.95, headless, device pixel ratio 2.
- Bundled JetBrains Mono, usually 14 px; 15/16 px are explicitly labeled below.
  Default 14 px cell metrics were 9x20 px, baseline 15 px.
- 108 browser scenario runs, with three repetitions per case. Each paint case
  had 16 warmup frames and 80 recorded frames per version, paced by browser
  animation frames. Paired canvases fit in the viewport, with alternating order.
  Both versions used the same native core. Paint results include small timing
  counters for viewport reads and row drawing, applied equally to both versions.
- Tables use the median of the three run medians and run 95th percentiles;
  observed maxima are shown separately where they matter. A p95 is the duration
  below which 95% of samples in that run fall.
- "Before" is the saved bundle immediately before browser input reuse and
  physical pixel alignment, including the earlier viewport-read optimization.
- Paint timing covers synchronous browser renderer work. Echo latency starts
  when a simulated output event enters the browser queue and ends when the
  canvas paint returns. It excludes keyboard/PTY/network latency and physical
  display presentation. These are component and scheduler measurements, rather
  than complete application or operating-system CPU benchmarks.
- Load cases use the real shared write and render schedulers, with one active
  pane, interactive echoes about every 50 ms, and scrolling build output in
  other panes. Canvases overlap and all registered panes remain eligible for
  painting; application visibility pausing and replica backlog recovery are
  excluded. This intentionally keeps covered background panes doing work.
- All 21 load runs drained their queued output completely: 307,928,208 bytes
  delivered and parsed. Current partial pixels matched full redraws in all
  completed paint cases; paired ordinary parser output also matched.
- Headless Chrome and this Windows machine do not establish Safari/Mac/iPad
  performance. Raw results retain outliers; they are not discarded as noise.

Current bundle SHA256:
`4ddff1bd73cd57e08c9a7a433b5f99992d106f941d507714e237e47b6a895c3b`

Baseline bundle SHA256:
`9b845b32d20bc3ff3573dd33c2e3ef85461847312b6518309b4018bdc681fca6`

Native core SHA256:
`e21dfe032b17e6c132f04203149728aceda6811f63f99c1a1d10a1265ea4afcb`

## Browser painting

| Geometry / renderer / scale / workload | Before median | Current median | Current p95 |
| --- | ---: | ---: | ---: |
| 80x24 / Experimental / 200% / full text | 2.3 ms | 2.3 ms | 5.8 ms |
| 80x24 / Experimental / 200% / one-row progress | 1.0 ms | 1.0 ms | 1.3 ms |
| 80x24 / Experimental / 125% / one-row progress | 0.9 ms | 1.3 ms | 1.7 ms |
| 160x60 / Experimental / 200% / full text | 9.3 ms | 9.3 ms | 10.7 ms |
| 160x60 / Stable / 200% / full text | 15.8 ms | 15.7 ms | 20.9 ms |
| 160x60 / Experimental / 200% / one-row progress | 1.7 ms | 1.6 ms | 2.5 ms |
| 160x60 / Experimental / 125% / one-row progress | 1.9 ms | 2.4 ms | 3.1 ms |
| 160x60 / Stable / 125% / one-row progress | 2.6 ms | 3.4 ms | 4.4 ms |
| 160x60 / Experimental / 125% / progress beside a small image | 2.3 ms | 2.3 ms | 3.2 ms |

Large full Experimental paints spent about 8.5 ms drawing rows and 0.3 ms
decoding the viewport. Stable spent about 15 ms drawing rows. Row drawing is
the main cost of these full paints; Experimental remains the useful default.
Stable's large full-paint p95 exceeds a 60 Hz frame's 16.7 ms reference budget.

For large partial Experimental paints, viewport decoding was about 0.6–0.8 ms.
Every non-idle recorded paint decoded one viewport. Partial decoding could
eventually avoid copying all 9,600 cells when only a few rows are damaged.

There is a measurable tradeoff in ordinary text at fractional column edges:
the protected damage pipeline paints an extra source-neighbor row. In the
160x60 default-font progress case it increased the median from 1.9 to 2.4 ms.
Integer-scale paints remained effectively unchanged. This overhead should be
kept visible in future optimization work rather than assuming every fractional
case became faster.

## Images and font scaling

| 160x60 Experimental image workload | Before median | Current median | Current p95 | Rows painted before / after |
| --- | ---: | ---: | ---: | ---: |
| 15 px font / 125% / small retained image | 9.4 ms | 0.8 ms | 1.0 ms | 60 / 3 |
| 15 px font / 150% / small retained image | 2.0 ms | 2.1 ms | 3.1 ms | 3 / 3 |
| 16 px font / 125% / small retained image | 9.4 ms | 0.8 ms | 0.9 ms | 60 / 3 |
| 16 px font / 150% / small retained image | 9.9 ms | 0.9 ms | 1.4 ms | 60 / 3 |
| 14 px font / 125% / retained 1024x720 sparse image | 2.7 ms | 2.8 ms | 4.3 ms | 3 / 3 |
| 14 px font / 200% / retained 1024x720 sparse image | 2.0 ms | 2.0 ms | 2.9 ms | 3 / 3 |

At 15 px, logical rows are 22 px high; at 16 px, they are 23 px high. Thus
15 px at 150% already had integer row edges, while the other zoomed cases
benefit from removing full redraws. The 3 painted rows include damage and
neighboring glyph sources.

The first current paint of the sparse 1024x720 image took approximately
41–41.4 ms, versus approximately 48 ms before. Its native write took roughly
1.8–2.1 ms current. The expensive first paint includes text, bitmap decoding,
copying/uploading pixels, and fragment compositing. A retained image is much
cheaper than its first display.

Dense 1024x720 striped Sixel behaved differently: a 1,709-byte command took
about 107 ms current / 98.5 ms before, increased current WASM linear memory
from 8 to 146.75 MiB, and produced **zero accepted images** in all three runs.
Its logical RGBA bitmap needs only 2.8125 MiB; the configured raster budget
was 64 MiB.

A direct Zig probe of the actual decoder confirmed the cause in
`internal/terminalcore/source/sixel.zig`, `ensureSize`: geometric growth can
double the stride when only height needs to grow. The probe reached stride
32,768 for a 1,024-pixel-wide image. At stripe 43 it requested 65.25 MiB for
the old and new rasters together and failed the 64 MiB budget. This is an
existing allocation/growth defect, present in the same core used by both
bundles. The test intentionally records the rejection rather than treating
the missing image as a successful rendering benchmark.

## Browser parsing and allocation reuse

| Workload | Before | Current | Input allocations before / current after warmup |
| --- | ---: | ---: | ---: |
| 38-byte ANSI progress write | 2.75 us/write | 2.30 us/write | 75,000 / 0 |
| 8,432-byte scrolling build output | 42.2 MiB/s | 41.5 MiB/s | 2,250 / 0 |

The reused input buffer retained 8 KiB for progress and 16 KiB for this build
chunk. Eliminating per-write scratch allocation is repeatable. Bulk parser
throughput was essentially unchanged; the small 1.7% difference should not be
treated as a demonstrated regression or improvement from three local runs.
Allocation counters cover calls to the exported WASM byte-array allocator,
rather than every allocation inside the native parser or JavaScript engine.

The 7,424-byte mixed Unicode case failed on its **sixth write**, before any
throughput measurement, with `RuntimeError: memory access out of bounds` in
all three runs of both versions. No speed figure is reported for that case.

A standalone probe calling the native export directly removed the renderer
and input adapter from the experiment:

| Native stream, 128 lines per write | Completed writes without failure | Result |
| --- | ---: | --- |
| ASCII | 300 / 38,400 lines | Completed |
| Accented Latin | 300 / 38,400 lines | Completed |
| CJK | 300 / 38,400 lines | Completed |
| Combining `é` | 86 / 11,008 lines | Next write trapped |
| Devanagari `देवनागरी` | 5 / 640 lines | Next write trapped |
| Mixed accented/CJK/combining/Devanagari | 5 / 640 lines | Next write trapped |

Updating and cleaning render state after each write did not prevent these
failures. This points to the native grapheme/Unicode path rather than the new
browser buffer reuse or deferred painting. The exact corrupting operation is
not yet identified; these are minimal reproduction workloads, not a claim
that all Unicode output fails.

## Multiple busy panes

All cases use 125% scaling and Experimental rendering unless labeled. Rates
refer to aggregate incoming build output. Echo values are browser receipt to
paint; they do not include host or network time.

| Panes / geometry / output rate | Echo median | Echo p95 | Largest observed echo delay | Largest queued build bytes |
| --- | ---: | ---: | ---: | ---: |
| 1 / 80x24 / 0.5 MiB/s | 12.5 ms | 18.7 ms | 22.9 ms | 74.1 KiB |
| 4 / 80x24 / 2 MiB/s | 9.2 ms | 13.5 ms | 14.5 ms | 49.4 KiB |
| 8 / 80x24 / 2 MiB/s | 7.0 ms | 11.8 ms | 80.5 ms | 172.9 KiB |
| 8 / 80x24 / 8 MiB/s | 6.8 ms | 10.7 ms | 23.2 ms | 1.22 MiB |
| 4 / 160x60 / 2 MiB/s | 6.1 ms | 11.0 ms | 486.6 ms | 963.4 KiB |
| 4 / 80x24 / 2 MiB/s / Stable | 8.0 ms | 11.5 ms | 142.6 ms | 345.8 KiB |
| 8 / 80x24 / 8 MiB/s / 1x and 30 fps | 8.0 ms | 15.1 ms | 24.8 ms | 1.93 MiB |

The active parser queue's median-run p95 was approximately 0.2–0.3 ms in
multi-pane cases. Active priority is working. Background panes also kept
progressing: about 45 paints/s per pane with 4 ordinary Experimental panes,
and about 30–32 paints/s with 8 panes. All queues finished draining within
28 ms of the final producer callback.

The occasional 80–487 ms echo outliers coincided with large animation-frame
gaps, while individual recorded paints remained under 15 ms and the long-task
observer reported no JavaScript tasks above 50 ms. These initial timings did
not identify the cause. The follow-up trace below narrows it to the Windows
graphics presentation path in this environment. Good median/p95 values do not
establish that the longest stalls are solved.

The 1x/30-fps comparison did not improve echo latency or peak backlog in these
runs; it reduced background paints to about 26/s. It remains a device-specific
option rather than an improvement demonstrated by this Windows load test.

## Follow-up tracing of echo stalls

The original 486.6 ms echo took 0.1 ms from receipt to parsing, followed by
486.5 ms before the paint completed. That run had a 465.3 ms animation-frame
gap; the active pane's longest individual paint was only 3.4 ms.

Nine additional traced four-pane 160x60 / 2 MiB/s runs investigated this:
six with Chrome's default graphics backend and three with `--disable-gpu`
as a diagnostic software-compositing control. The trace adds measurement
overhead, so these are cause-isolation experiments rather than replacement
throughput numbers for the original tables.

The default backend used Intel UHD Graphics 630, driver 31.0.101.2134, ANGLE
Direct3D 11, with GPU canvas/raster/compositing and DirectComposition enabled.
The software control reported GPU compositing and rasterization disabled.

In one default traced run, an echo took 426.7 ms: parsing took 0.2 ms and the
paint waited 426.5 ms. The overlapping trace showed:

- `DXGISwapChainImageBacking::Present` on Chrome's GPU thread: 400.84 ms.
- `ProxyImpl::FinishGLOnImplThread` on the compositor: 377.82 ms.
- `LayerTreeHost::~LayerTreeHost` / `ProxyMain::Stop` on the renderer main
  thread: about 381 ms, waiting during compositor teardown.
- A 439.2 ms frame callback gap and a 394.4 ms timer callback gap.

A second set of default-backend runs reproduced 416.5, 389.6, and 166.1 ms
maximum echo delays. Their overlapping Windows presentation operations lasted
395.2, 361.9, and 150.4 ms respectively. In the third, the browser's native
renderer wait also delayed parsing; it was not a slow native terminal write.
Another traced case delayed frames while ordinary timers and parser work kept
running, with a 201.3 ms Windows presentation operation.

All three software-control runs had maximum echo delays of approximately
30.2–30.4 ms and no events above 50 ms overlapping those slowest echoes.
The long-task API reported zero long tasks in all nine runs, even where the
trace exposed long browser-internal renderer waits. That observer alone
cannot rule out a browser graphics stall.

This supports the Windows graphics presentation/compositor path as the source
of the reproduced stall class. Prioritizing the active terminal cannot force
an animation-frame callback while Chrome is waiting on graphics work. It does
not yet distinguish the driver, DirectComposition, headless-window behavior,
or a canvas/layer transition as the underlying trigger. The original 486.6 ms
sample itself was not traced. The next useful check is reproducing this in a
visible browser/app and comparing graphics paths and canvas dimensions before
changing product defaults. Disabling GPU rendering here was a test control,
not a settings recommendation.

The reusable probe is `scripts/terminal-benchmark/frame-stall-probe.mjs`.
It accepts the browser harness's `--playwright`, `--chrome`, `--output`, and
`--repeats` arguments, plus `--graphics=software` for the control. It saves
Chrome trace files, individual benchmark/heartbeat samples, graphics feature
status, and a summary. Saved data is under:

- `.cache/review/terminal-frame-stalls-2026-10-04/`
- `.cache/review/terminal-frame-stalls-default-control-2026-10-04/`
- `.cache/review/terminal-frame-stalls-software-2026-10-04/`

## Host core and retained-image cleanup

Existing Go benchmarks ran for 500 ms, three repetitions, using the pinned
core through wazero. The host-output cases include reply and clipboard drains.

| Host workload | Median time | Throughput | Go heap allocations/op |
| --- | ---: | ---: | ---: |
| ANSI progress, complete host core path | 3.09 us | 12.28 MB/s | 6 |
| 8 KiB build output, complete host core path | 446.8 us | 18.87 MB/s | 6 |
| Replies and clipboard effects | 4.40 us | 8.86 MB/s | 14 |
| Plain text parser | 181.5 us | 18.33 MB/s | 2 |
| Tiny write, retained image, 0 initial history lines | 7.69 us | — | 2 |
| Tiny write, retained image, 1,000 initial history lines | 115.0 us | — | 2 |
| Tiny write, retained image, 10,000 initial history lines | 156.9 us | — | 2 |

Go reports decimal MB/s; browser tables use MiB/s. Go heap counters include
runtime call allocations and amortized linear-memory growth during the timed
history buildup, and should not be interpreted as native per-event leaks.

The separate native JS benchmark measured about 0.144 us for a tiny text-only
write with roughly 10,000 history lines, versus 73.23 us with one retained
image. Page membership already avoids scanning all text-only cells, but
collection still scans image-bearing pages on every write. This remains a
substantial cost for terminals that retain images in long history. The current
Go result is consistent with the previously recorded approximately 157 us
result in task 137, rather than a new regression.

## Memory lifecycle

Three runs each opened, wrote to, painted, and disposed 8 terminals for 20
cycles: 480 terminal lifecycles. WASM linear memory stayed at 43.125 MiB from
the first to the last cycle in every run. The eight input buffers retained
128 KiB while live, and every input pointer/capacity was zero after disposal.
There was no upward linear-memory growth in this scenario.

Under sustained output, the shared browser module reached about 46.5 MiB for
4 typical panes and 99.25 MiB for 8. These are WASM linear-memory high-water
allocations, not total browser RAM, JavaScript heap, GPU surfaces, or leaked
memory measurements. Dense rejected images have a much larger high-water cost,
as described above.

## Native fixes and regression measurements (task 152)

The Unicode failure came from recycled non-pooled WASM page allocations whose
cell memory was not zeroed before initialization and cloning. Stale cell flags
could masquerade as live grapheme metadata. ReleaseSafe cleared this memory;
ReleaseSmall did not. The pinned-source patch now clears those page allocations
in the production build. Ordinary pooled pages retain their existing cleanup.

Sixel capacity now grows only an exhausted axis. A 1024x720 dense raster keeps
its stride at 1024 with capacity height 768, rather than repeatedly doubling
width. The measured peak reservation for old/new raster copies fell from
65.25 MiB (rejected partway through decoding) to 4.5 MiB (accepted).

The fixed core SHA256 is:
`548879d1387ff35d5daa4e85724c26ce6bd2a01856203b991475fa3e7e3d8af4`.
The rebuilt browser bundle SHA256 is:
`08b4eb1761c9d55091357f361c2392065dc8f15f7ff9ddac7df0e4c4b417754e`.
The original core/bundle identities above continue to identify the original
measurements, rather than the newly fixed artifacts.

All 12 standalone Unicode workloads completed 300 writes / 38,400 lines each.
Nine additional browser parsing runs included three mixed-Unicode cases; the
fixed core completed 2,350 writes / 300,800 lines per run, including warmup,
while the saved old bundle still trapped on write six. Median measured Unicode
throughput was 11.86 MiB/s. Ordinary build output measured 41.77 MiB/s. The
saved baseline remains the pre-input-reuse bundle, so its ordinary parser
timings also include that earlier adapter difference.

Twenty-one additional image scenarios completed. The dense image was accepted
in all three repetitions. Median write time was 9.3 ms with the fixed core,
versus 112.8 ms with the saved old bundle. Fixed-core WASM linear memory grew
from 8 to 16.0625 MiB, versus 146.6875 MiB in that saved bundle. The original
input-reuse bundle had reached 146.75 MiB before this native fix. These are
module high-water measurements, not the decoded-raster reservation limit.
Completed incremental image paints matched their fresh full redraws.

Four new JavaScript core regressions fail against the old artifact and pass
after rebuilding. They cover valid grapheme preservation, history eviction,
reflow, snapshot restoration/continuation, and every dense-image pixel under
a 16 MiB budget. Corresponding host tests pass through wazero. All 503
JavaScript tests, six Zig decoder tests, the Go suite (with the existing
ephemeral-port test overlay), vet, and Windows executable build passed. Fresh
source-build verification reproduced the new WASM bytes exactly. Data and logs
are retained under `.cache/review/terminal-native-fixes-152/`.

The graphics stalls traced above are a separate finding. These native fixes
do not change Chrome's Windows graphics backend. Applying this build requires
restarting the host and reloading browsers so both sides use the new core.

## Next work suggested by the measurements

1. Completed in task 152: fix native combining/Devanagari traps, with regression
   fixtures for page growth and restoration.
2. Completed in task 152: correct Sixel raster axis growth and verify dense
   image acceptance, pixels, memory limits, and decode time.
3. Completed in task 153: skip unchanged retained-image collection, with immediate
   cleanup after attachment mutations and ordinary parsing isolated from tracking.
4. Completed in task 153: sparse native reads for partial paints and browser
   bitmaps created only for painted visible images. Large full text paints and
   first compositing of a large visible image remain substantial costs. See
   [the follow-up measurements](terminal-performance-2026-10-05.md).
5. Reproduce the graphics presentation stalls in a visible browser/app and
   compare graphics backends and canvas dimensions before changing fairness,
   coalescing, or graphics defaults based on the headless results.

## Reproduction and saved data

The checked-in browser harness is `scripts/benchmark-terminal-browser.mjs`,
with fixtures in `scripts/terminal-benchmark/`. It needs an installed Playwright
module and Chrome executable. It does not install dependencies, change terminal
settings, attach to live sessions, or restart the running Tessera server.

From the repository root, using the installed paths on this machine:

```powershell
node scripts/benchmark-terminal-browser.mjs --playwright=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs --chrome="C:/Program Files/Google/Chrome/Application/chrome.exe" --output=.cache/review/terminal-performance-rerun --baseline=.cache/review/terminal-input-pixels-150/before-terminal.js --repeats=3
```

Omit `--baseline` to measure only the current build. Use `--group=paint`,
`images`, `parse`, `load`, or `memory` for individual groups. Failed diagnostic
workloads are recorded with error/rejection fields rather than throughput.

```powershell
go test ./internal/terminalcore -run '^$' -bench 'BenchmarkCore(HostOutput|TextOutput|SmallWritesWithRetainedImage)$' -benchmem -benchtime=500ms -count=3
node scripts/benchmark-terminal-core.mjs --retained-images-only
node scripts/terminal-benchmark/unicode-probe.mjs
.cache/zig-x86_64-windows-0.15.2/zig.exe test --dep sixel '-Mroot=scripts/terminal-benchmark/dense-image-probe.zig' '-Msixel=internal/terminalcore/source/sixel.zig'
```

Raw data is saved in `.cache/review/terminal-performance-2026-10-04/`:
`paint-results.json`, `images-results.json`, `parse-results.json`,
`load-results.json`, `memory-results.json`, `host-benchmarks.txt`,
`native-retained-images.txt`, `unicode-probe.jsonl`, and
`dense-image-growth.log`. Each browser results file includes the environment
and bundle/core identities. Benchmark scripts and this report are the only
new repository artifacts from this measurement request; product code was not
changed during testing.
