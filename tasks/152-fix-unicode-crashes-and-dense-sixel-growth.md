# Fix native Unicode crashes and dense Sixel raster growth

Status: complete.

## Request

Fix the two native terminal bugs found during performance testing: repeated
combining/Devanagari output traps in WASM, and dense 1024x720 Sixel raster growth
exceeds the image budget despite the logical image needing only 2.8125 MiB.

## Requirements

- Identify and correct the native Unicode failure without dropping valid text
  or disabling graphemes. Preserve scrolling, reflow, snapshots, and cleanup.
- Grow Sixel raster dimensions independently, preserve existing pixels, and
  keep decoded-storage and transient-copy budget enforcement intact.
- Add native/core regression coverage for the original failing streams and
  dense images, including restoration and memory limits.
- Rebuild the pinned WASM and embedded browser bundle together, verify the
  source build, and rerun the diagnostic workloads with measurements.

## Validation

- The Unicode cause was stale cell/grapheme metadata in recycled unpooled WASM
  page allocations. The checked pinned-source patch clears those pages before
  initialization/cloning, retaining the ordinary pooled-page cleanup path.
- Sixel grows only an exhausted axis. The original dense image keeps its stride
  at 1024 and reaches capacity height 768, with a 4.5 MiB transient-copy peak.
- Four new JavaScript core regression tests failed against the old artifact and
  pass after rebuilding. They cover sustained combining/Devanagari/mixed output,
  10,000-line history eviction, grapheme reads, resize/reflow, snapshots, ongoing
  writes, and dense image pixels under a 16 MiB budget through partial/full
  snapshot restoration. Go adds the same native output and image workloads.
- All 503 JavaScript tests, all 6 Zig decoder tests, `go vet ./...`, and the
  Windows executable build passed. The complete Go suite passed with the
  already-validated temporary overlay that uses an ephemeral HTTP port for the
  persisted-HTTPS test; the running server occupies its original fixed port.
- Fresh `npm run build:terminal-core` and `npm run verify:terminal-core` produced
  identical WASM: `548879d1387ff35d5daa4e85724c26ce6bd2a01856203b991475fa3e7e3d8af4`.
  `npm run build:web` embeds that artifact and compatibility identifier.
- All 12 standalone Unicode probe cases completed 300 writes / 38,400 lines
  each. A reused-module probe also created/disposed 40 terminals and checked
  that each started with empty cells.
- Nine browser parsing and 21 image scenarios completed. Current mixed Unicode
  parsed 2,350 writes / 300,800 lines per run (100 warmup + 2,250 measured),
  while the saved old bundle still trapped on the sixth write in every run.
  Its current median measured throughput was 11.86 MiB/s.
- Dense Sixel was accepted in all three browser runs. Median native write time
  was 9.3 ms versus 112.8 ms with the saved old bundle. Current WASM linear
  memory grew from 8 to 16.0625 MiB, versus 146.6875 MiB in the old bundle.
  Completed incremental image paints still matched fresh full redraws.
- Results, diagnostics, logs, and the built executable are retained in
  `.cache/review/terminal-native-fixes-152/`. The performance report records
  original and post-fix measurements separately. Diff/syntax checks passed.

The running host was not restarted. It and the browser must load the matching
new core together; restart the host and reload clients when applying the build.
