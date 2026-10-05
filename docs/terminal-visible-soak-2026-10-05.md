# Visible Chrome terminal soak — 2026-10-05

**Repair follow-up:** task 155 fixed the native crash and passed its regression
and longer native checks. Its hardware soak still failed on a separate canvas
corruption and presentation stall. See
[the repair and validation report](terminal-page-initialization-2026-10-05.md).
The results below preserve the original pre-fix test.

The 10-minute load test did not reproduce the earlier 400–487 ms graphics
presentation stall. It did expose a reproducible native terminal memory trap
after terminal creation/disposal and an image-plus-Unicode workload. This build
should not be tagged until that native crash is addressed.

## Tested build and environment

- Browser bundle: `10f44f13ca8c4d2fe46aad56d186597ae865d8d1ca2437f07d4d82cf14cab48b`.
- Native core: `6dd1129f3f4c27243da9f2b9fede9c47f9316e7d1ace4a0abb5fc9fceed89c82`.
- Chrome 154.0.8037.95, visible window, 1600×1000 viewport, emulated DPR 2,
  terminal pixel-ratio cap 1.25 during load.
- Intel UHD 630, driver 31.0.101.2134, ANGLE Direct3D 11. GPU canvas,
  rasterization, and compositing were enabled; no software-rendering override.
- Isolated synthetic terminal streams using the current browser renderer and
  scheduling code. The running server, user sessions, and product settings were
  untouched. This is not a PTY/network end-to-end soak.
- A 32 MiB rolling Chrome graphics trace ran during each phase, with a 100 ms
  echo trigger. Tracing adds overhead, so these timings are diagnostic results.
  No screenshot or canvas pixel readback occurred during timed output.

## Sustained output results

| Phase | Duration | Panes / geometry | Output | Echo median | Echo p95 | Worst echo |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Experimental renderer | 4 min | 4 overlapping, 160×60 | 2 MiB/s | 18.0 ms | 21.2 ms | 57.1 ms |
| Classic renderer | 3 min | 4 overlapping, 160×60 | 2 MiB/s | 8.8 ms | 11.2 ms | 46.7 ms |
| Heavier output | 3 min | 8 overlapping, 80×24 | 8 MiB/s | 19.4 ms | 20.8 ms | 53.4 ms |

All 9,610 echo probes were parsed and painted. All 2,279.94 MiB (~2.23 GiB)
of generated output drained. The final active-pane echo marker matched in each
phase. No echo reached the 100 ms trace threshold. The classic renderer
recorded 20 long tasks; the other phases recorded none. A short absence of
stall reproduction does not establish that the earlier intermittent graphics
issue is fixed on every machine or browser session.

## Native crash reproduced after lifecycle checks

Following the output soak, the same browser page created and disposed eight
terminals in each of 20 cycles (160 terminals). Disposal validation passed,
and the longest measured lifecycle cycle was 11.8 ms.

The next checks exercised full classic paints, sparse paints, styled Unicode,
and images with Unicode, repeatedly in the same page and WASM instance. The
first three checks passed. The fourth, an image-plus-Unicode case at 15px font
size and 125% scaling, trapped during native terminal writing:

```text
RuntimeError: memory access out of bounds
wasm-function[172]:0x10059
wasm-function[258]:0x1c5b2
wasm-function[309]:0x220bf
wasm-function[320]:0x231be
wasm-function[638]:0x3d6ba
```

The short setup run independently reproduced the same first failure and stack.
In the longer run, the following 20 checks also trapped in that shared WASM
instance. Those are follow-on failures after the first crash, not evidence of
21 independent defects. The overall test exits nonzero and is a failed release
validation result.

This is a native memory-safety failure, separate from a canvas pixel mismatch
or Chrome waiting to present a frame. Allocator reuse/page initialization is
an investigation target; the exact cause has not been established by this test.
No product fix was made during the measurement, preserving the tested build.

## Follow-up allocation diagnosis

An isolated source experiment narrowed the crash to page initialization. The
pinned core's `PageList.initPages` clears new page buffers only in builds with
runtime safety enabled. Its comment assumes release allocations come from
zeroed OS pages. Zig's WASM page allocator instead shares a heap that recycles
freed allocations, so newly allocated terminal cells can contain stale data.

Three additional short visible-browser runs used the same lifecycle sequence:

| Core | Image-plus-Unicode result |
| --- | --- |
| Unchanged release candidate | Same native memory trap |
| Clear initial and growing page buffers | Passed all four rendering checks |
| Clear only initial page buffers | Passed all four rendering checks |

Both experiments kept all other source and the browser renderer unchanged.
This supports fixing the initial page allocation path; newly allocated pooled
pages should receive the same initialization guarantee. The experiments only
changed a disposable cached checkout and test bundles. The product WASM and
browser bundle still have the hashes listed above.

The implementation should explicitly initialize page memory, add a regression
that creates and disposes terminals in one shared WASM instance before writing
images and Unicode, rebuild both bundled cores, and rerun the longer soak and
performance checks. The short experimental passes do not replace that release
validation. Diagnostic artifacts are under
`.cache/review/terminal-crash-probe-155/`, including `unchanged-control/`,
`zeroed-pages-test/`, and `initial-pages-only-test/`.

## Reproduction and artifacts

```powershell
node scripts/terminal-benchmark/visible-soak.mjs --playwright=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs --chrome="C:/Program Files/Google/Chrome/Application/chrome.exe" --output=.cache/review/terminal-visible-soak-rerun
```

Use `--quick=true` for the short reproduction sequence; its output phases run
for one second each, followed by the same 160-terminal lifecycle exercise and
the first four rendering checks. The standalone benchmark also accepts
`--duration-ms` for longer load cases. Neither command changes graphics defaults.

Saved artifacts are under `.cache/review/terminal-visible-soak-154/`:

- `main/results.json`: full load results, echo timestamps, and rendering failures.
- `main/environment.json`: exact build, GPU, browser, and viewport identities.
- `main/progress.json` and `terminal-visible-soak-154-main.log`: periodic progress
  (the log is in the parent `.cache/review/` directory).
- `main/lifecycle.json`: terminal creation/disposal validation.
- `main/trace-pixel-checks-pixel-failure.json`: captured trace around the first
  native failure (about 17.4 MB).
- `pilot/`: independent short reproduction and its trace.

The previous 511-test suite and isolated rendering matrices passed; this
same-instance lifecycle sequence exposes a coverage gap those checks did not
catch. Release readiness should be reassessed after a native fix and rerun.
