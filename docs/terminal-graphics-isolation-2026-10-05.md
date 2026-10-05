# Terminal graphics isolation — 2026-10-05

The remaining stalls include time spent waiting or not running on Chrome's GPU
thread. A trace of plain Canvas2D text, without Tessera, reproduces the long
Windows presentation event. The exact native wait and the original severe
pixel corruption are still unconfirmed. No product rendering policy or driver
was changed in this investigation.

## What the earlier traces establish

The original classic stall's `DXGISwapChainImageBacking::Present` event lasts
360.433 ms in wall time, but records only 0.437 ms of GPU-thread CPU time. The
CPU-canvas candidate's three `CommandBufferService:PutChanged` events last
472.737–497.053 ms, with only 4.466–10.364 ms of thread CPU time. Their nested
raster operations are short. These durations are not evidence that drawing
glyphs consumed half a second of CPU. A driver/synchronization wait or Windows
descheduling is consistent with them; the browser trace alone does not
distinguish those causes.

Chromium's [command-buffer implementation](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/command_buffer/service/command_buffer_service.cc)
shows that `PutChanged` wraps command decoding, rather than identifying one
particular graphics call. The
[raster decoder](https://chromium.googlesource.com/chromium/src/+/master/gpu/command_buffer/service/raster_decoder.cc)
contains both raster work and other command handling. Do not label the entire
497 ms event as expensive rasterization.

The [Windows presentation source](https://chromium.googlesource.com/chromium/src/+/d32fcc67c91989632acf3ec5fb8265c04b433cbe/gpu/command_buffer/service/shared_image/dxgi_swap_chain_image_backing.cc)
contains a DXGI presentation call and, for a new swapchain's first presentation,
a GPU completion wait. The captured event does not identify which operation
was waiting. A [July Chromium cleanup](https://chromium.googlesource.com/chromium/src/gpu/+/e6ecbb88cd2fbe89dad3691fb31c46d02e9b9140)
also explains that presentation in that path already used interval zero;
changing a terminal's frame limit or blaming one ordinary vblank does not
explain a 360 ms event.

## Standalone canvas control

Added `scripts/terminal-benchmark/graphics-isolation.mjs` and its small browser
fixture. It serves only HTML, JavaScript, and the bundled font. It does not load
a terminal library, WASM, images, a PTY, or the application's write/render
schedulers. Each run launches its own visible temporary Chrome and an ephemeral
loopback server.

The load fixture draws four overlapping 160×60 text canvases at ratio 1.25. It
updates one active echo row and six rows per background canvas on each frame.
The drawing uses the classic renderer's per-cell font/color operations, opaque
black row backgrounds, and the current 9×20 cell / 16 px baseline metrics.
Echo latency measures the timer callback to the end of its JavaScript drawing,
not physical display latency. No readback occurs during timed load.

Machine: visible Chrome 154.0.8037.95, Intel UHD 630, ANGLE D3D11, Intel driver
31.0.101.2134. The installed driver's date is November 2024; age alone is not
evidence that the driver causes this failure. The GPU feature status recorded
by Chrome confirms that each control actually selected its intended path.

### Initial trace controls

Each interval lasts 90 s. This initial trace configuration includes GPU device
timing queries. Trace extraction occurs after timing, so it cannot cause the
original outlier.

| Browser graphics control | Echo p95 | Worst echo | Long JavaScript tasks |
| --- | ---: | ---: | ---: |
| Default hardware | 12.5 ms | 13.5 ms | 0 |
| Canvas acceleration disabled; compositor GPU retained | 10.6 ms | 406.4 ms | 0 |
| Compositor rasterization disabled; canvas GPU retained | 11.3 ms | 310.4 ms | 0 |
| Browser GPU disabled | 19.1 ms | 37.1 ms | 0 |

The rasterization-disabled run contains six echoes above 100 ms. Its retained
trace includes a 369.032 ms `DXGISwapChainImageBacking::Present` event, with
32.139 ms of thread CPU time. The dirty rectangle is `0,87 820x21`: a single
thin row, rather than a large terminal repaint. Other long events include a
315.822 ms presentation and a 329.032 ms command-buffer event. These reproduce
the same browser-level paths observed in the terminal traces with no terminal
code present. The rolling buffer discarded the canvas-disabled run's early
stall; there is no captured call to attribute that particular 406.4 ms outlier.

### Untraced controls

Four fresh browsers, 90 s each, no trace, no readback. All four intervals stay
below 100 ms. This is a negative result, not proof that any flag fixes an
intermittent problem.

| Browser graphics control | Echo p95 | Worst echo | Long JavaScript tasks |
| --- | ---: | ---: | ---: |
| Compositor rasterization disabled | 23.9 ms | 54.9 ms | 0 |
| Default hardware | 21.7 ms | 47.0 ms | 0 |
| DirectComposition disabled | 24.2 ms | 29.9 ms | 0 |
| Microsoft WARP D3D11 software adapter | 21.2 ms | 31.6 ms | 15, maximum 58 ms |

Chrome confirms that DirectComposition is disabled in its control and that
WARP uses Microsoft Basic Render Driver while browser compositing remains
enabled. These switches are documented in Chromium's
[GL switches](https://chromium.googlesource.com/chromium/src/+/master/ui/gl/gl_switches.cc).
The WARP control introduces additional CPU cost; neither control warrants a
product/browser default change from this sample.

Profiling changes the behavior materially: frame intervals differ between the
traced and untraced runs. Chromium's
[GPU tracer](https://chromium.googlesource.com/experimental/chromium/src/+/HEAD/gpu/command_buffer/service/gpu_tracer.cc)
performs additional GPU timing work when device tracing is enabled. Do not use
the isolated traced outlier frequency as the normal-user failure rate. The
previous [untraced Tessera comparison](terminal-graphics-reliability-2026-10-05.md)
already recorded 372.5/472.7 ms stalls; tracing is not necessary for the broader
terminal symptom, but may amplify it or introduce a different wait.

### Trace control without device timing queries

Two further 90 s intervals use service/decoder tracing, with GPU device timing
queries disabled. Rasterization-disabled/default worst echoes are 25.2/54.6 ms,
with no long JavaScript tasks and no echoes above 100 ms. This is similar to the
untraced controls and materially different from the device-timing trace.

The checked-in runner now defaults to this service/decoder trace configuration.
It can stop recording after the first stall and defer stream extraction until
timed work finishes. The original terminal traces used neither device nor
service/decoder timing categories; those failures cannot simply be dismissed as
the device-timing profiler behavior found in this smaller control.

## Reassessing the original pixel corruption

The original failure is an 8×4 region at bitmap coordinates
`[1904,2308,1911,2311]`, in a 2880×2400 bitmap displayed at 1440×1200 CSS pixels.
The test viewport was 1600×1000 CSS pixels. The damaged region therefore begins
at CSS y=1154, below the visible viewport. The saved failure was obtained from
canvas readback. There is no compositor screenshot of that region, so it does
not establish visible on-screen corruption.

Thirty pixels changed from opaque grayscale to random colors/alpha, with a
maximum channel change of 255. A repeat read was stable, and another paint
changed the hash again. Independently decoding the two saved PNG exports finds
the same 30 changed, colored, translucent pixels and matching channel values.
This rules out a hash-comparison mistake or damage limited to one returned
`ImageData` array; both APIs still depend on browser canvas readback. This is
much larger than the one-level glyph rounding
change and remains a real unresolved pixel-validation failure. Its location
does not justify ignoring it. A drawing/readback/backing-store problem is
plausible; the evidence does not identify whether the damaged bitmap came from
Skia, ANGLE, the driver, or another graphics allocation path.

Ran 64 standalone pixel checks: eight repetitions at the page origin and eight
fully offscreen for each of the four initial graphics controls. Each creates a
fresh 2880×2400 canvas, paints 96 complete classic-style frames, repeats its
read, then paints identical content and reads again. Separate invariants reject
any nonopaque or nongrayscale pixel, since this fixture draws only opaque
grayscale text/backgrounds.

- No severe corruption occurred. Every read remained opaque grayscale, and
  every repeated read matched.
- The 32 accelerated-canvas comparisons reproducibly changed approximately
  248,162 pixels by at most one grayscale level on the first identical repaint
  after readback. These are recorded as differences, not described as exact
  pixel passes.
- The 32 software-canvas comparisons matched exactly.

This gives a repeatable browser-only control for the rounding behavior and a
stronger oracle for severe corruption. It does not reproduce or repair the
original 30 colored/translucent pixels.

## Remaining boundary and next evidence

Confirmed: terminal parsing is not needed to exercise the captured long Windows
presentation path; the severe original artifact was below the test viewport;
ordinary one-level readback rounding is a separate browser behavior. Unconfirmed:
the specific native wait, whether the original colored corruption appeared on
screen, and a generally effective mitigation.

The next decisive stall evidence is a Windows CPU/GPU scheduling trace with
native wait stacks correlated to the browser GPU thread. Windows Performance
Recorder is available and no recording was active, but Windows Performance
Analyzer is not installed here. This investigation has not started a system
recording, installed tooling, changed drivers, or restarted Windows.

For corruption, capture raw RGBA and compositor pixels before any diagnostic
repaint. The standalone runner has that failure hook; its current screenshot
captures the visible viewport, so a failure outside the viewport still needs
an independent compositor capture of the affected area to establish visibility.

Product bundle/core identities remain unchanged:

- Browser: `2620caa0108dd6d874ac2e567aea14468287231db0827ef9857d1fb7de877dba`.
- Core: `c08061da69e1d6157e5eb2bc6314991c47283b14aaa00618d92d4478fa33b25f`.

The ten 90 s load controls total 15 minutes, plus 64 pixel checks.
Artifacts are saved under `.cache/review/terminal-graphics-157/`: feature/driver
metadata, load/pixel results, four initial traces, nested trace summaries,
decoded original PNG pixels, and untraced/service-profiled controls. Syntax and
final browser smoke checks validate the diagnostic
runner. The live Tessera host and user terminals were untouched.

Example repeat command:

```text
node scripts/terminal-benchmark/graphics-isolation.mjs --playwright=<module> --chrome=<executable> --profiles=default,no-raster-gpu --duration-ms=90000 --pixel-repeats=8 --trace=true --output=<directory>
```

Use `--trace=false` for latency measurements, `--trace-mode=service` for browser
command attribution, and `--trace-mode=device` only as an explicit instrumented
control. No flag is applied to an existing browser.
