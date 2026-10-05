# Terminal release polish measurements — 2026-10-05

Task 153 implements all three approved changes: skip unchanged retained-image
collection, read native rows sparsely for partial paints, and create browser
image bitmaps only for visible fragments being painted.

**Later release validation:** task 154 reproduced a native memory trap after
terminal reuse and image/Unicode output. Task 155 fixed it, but the repaired
build's hardware soak still reproduced a graphics presentation stall and canvas
corruption. Do not treat the earlier checks below as release sign-off. See
[the repair report](terminal-page-initialization-2026-10-05.md) and
[the original soak results](terminal-visible-soak-2026-10-05.md).

## Final artifacts and baseline

Windows 11, Intel Core i7-8850H / UHD 630, Node 24.15.0, Chrome
154.0.8037.95, bundled JetBrains Mono. Timing comparisons use paired terminals,
alternate their order, and exclude pixel readback. The targeted browser cases
have three repetitions with 80 measured frames each. Tiny-write native results
are medians of five samples. These are workload measurements, not whole-app
speedup estimates.

| Artifact | SHA256 |
| --- | --- |
| Saved pre-task core | `548879d1387ff35d5daa4e85724c26ce6bd2a01856203b991475fa3e7e3d8af4` |
| Saved pre-task browser bundle | `08b4eb1761c9d55091357f361c2392065dc8f15f7ff9ddac7df0e4c4b417754e` |
| Final verified core | `6dd1129f3f4c27243da9f2b9fede9c47f9316e7d1ace4a0abb5fc9fceed89c82` |
| Final browser bundle | `10f44f13ca8c4d2fe46aad56d186597ae865d8d1ca2437f07d4d82cf14cab48b` |

The baseline includes task 152's Unicode and dense-raster fixes. Final native,
parser, targeted paint/history, and packaged-app results use the final hashes
above. Earlier exploratory matrices used intermediate artifacts; their own
environment files identify those bytes.

## Results

| Workload | Before | Final |
| --- | ---: | ---: |
| Tiny native write, one retained image and ~10k history lines | 72.288 µs | 0.222 µs |
| Same native write without images | 0.133 µs | 0.131 µs |
| Host/wazero retained-image write | ~158–161 µs | 0.495 µs |
| 160×60 partial paint, experimental renderer, 125% | 3.0 ms | 2.0 ms |
| Cells decoded in that partial paint | 9,600 | 480 |
| Native read + cell decode in that paint | 1.0 ms | 0.1 ms |
| First paint with 16 history images and one visible image | 16.3 ms | 10.6 ms |
| Browser bitmaps created for that first paint | 17 | 1 |
| Bitmap RGBA storage for that first paint | 7.969 MiB | 0.469 MiB |

Full paints preserve one bulk viewport read. In the final 20-case matrix, large
experimental full paints measured 9.2 → 9.2 ms at 125% and 9.1 → 9.1 ms at 200%.
The classic renderer measured 16.6 → 17.0 ms and 15.7 → 15.6 ms respectively.
All final matrix parser comparisons and partial/full pixel comparisons passed,
including styled Unicode, combining characters, images, and fractional rows.

Ordinary build parsing measured 42.46 → 41.30 MiB/s (2.7% lower); mixed Unicode
measured 11.91 → 12.04 MiB/s. A five-repeat tiny ANSI-progress follow-up measured
3.024 → 2.933 µs/write. An initial implementation reduced ordinary build
throughput by about 15% and was replaced: ordinary writes now keep the original
parser handler, with image tracking and its stack/code isolated in a separate
specialization selected once per write.

In a visible Chrome browser, three four-pane 160×60 load runs at 2 MiB/s
drained every background stream and painted every echo. Median echo latency
across runs was 18.6 ms, median p95 was 21.1 ms, and the largest echo was
34.3 ms; no long tasks were recorded. This short visible-browser check does
not directly compare with the earlier headless 487 ms stall measurement.

## Correctness and release checks

- 511 JavaScript tests and the Go suite passed. The Go suite used the existing
  test overlay that changes one test listener from port 7331 to an ephemeral
  port, preserving the running server.
- Six Zig decoder tests, `go vet ./...`, and the Windows executable build passed.
- A fresh pinned-source checkout reproduced the final WASM bytes exactly.
- The browser bundle was rebuilt with that core; release CI now includes the
  browser patch tests and Firefox clipboard bridge tests.
- Disposable packaged-app checks at 125% and 150% scaling passed typed commands,
  combining/Devanagari output, three-pane reload/restoration, and all six matching
  host/browser core attachments, with no page errors.
- New regressions cover immediate reclamation independently of rendering dirty
  flags; partial UTF-8/OSC state across image tracking and snapshots; row bytes,
  bounds, scratch reuse, memory growth, and recovery; and on-demand image
  creation across history, alternate screens, snapshot restoration, and growth.

## Graphics diagnostic limitation

An intermediate long hardware run stopped on a full-paint pixel mismatch.
One mismatch was a one-unit color rounding change after Chrome switched its
canvas readback backend; the old bundle reproduces that too. The harness keeps
exact checks in a stable readback context for this case, outside the timing loop.
Larger differences still fail.

A separate intermediate classic-renderer run produced a corrupted 31-pixel
block after a forced full repaint. Twelve paired old-bundle controls did not
reproduce that corruption, so its cause remains unconfirmed. The complete
20-case software matrix and final 20-case hardware matrix passed exact checks.
Those passes do not establish that the intermittent graphics issue is fixed.
No graphics defaults were changed, and task 153 does not claim to fix the earlier
Chrome presentation/echo stalls.

## Reproduction

Raw data and diagnostic logs are under
`.cache/review/terminal-release-polish-153/`. Final measurements are in
`native-final.log`, `host-final.log`, `parse-isolated/`, `progress-final/`,
`partial-final/`, `history-final/`, and `paint-rebuilt/`. Packaged smoke results
are `packaged-smoke-1.25.json` and `packaged-smoke-1.5.json`.
The visible-browser load data is in `load-visible/`.

```powershell
node scripts/benchmark-terminal-core.mjs --retained-images-only --compare=.cache/review/terminal-release-polish-153/before.wasm
go test ./internal/terminalcore -run '^$' -bench '^BenchmarkCoreSmallWritesWithRetainedImage/history_10000$' -benchtime=300ms -count=3
node scripts/benchmark-terminal-browser.mjs --playwright=C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs --chrome="C:/Program Files/Google/Chrome/Application/chrome.exe" --output=.cache/review/terminal-polish-rerun --baseline=.cache/review/terminal-release-polish-153/before-terminal.js --group=paint --repeats=3
```

The browser harness also accepts `--group=images|parse|load|memory`, a JSON
`--filter`, `--headed=true`, and a diagnostic `--graphics=software` control.
These affect only isolated benchmark browsers and do not alter product settings.
