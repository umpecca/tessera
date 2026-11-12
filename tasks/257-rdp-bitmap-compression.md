# Task 257: Compress kept-RDP bitmap fallback

Status: implementation and automated verification complete (2026-11-11);
live-server and physical-device acceptance deferred to the combined testing block.

## Request

Implement bitmap-fallback compression despite H.264 being the user's normal
mode. Preserve H.264 performance and defer hands-on acceptance to the combined
testing block.

## Scope

- Negotiate WebSocket permessage-deflate for kept-session viewers and enable it
  selectively for sufficiently large, flat/text-like bitmap messages, never
  H.264/control frames. Skip noisy-looking bitmaps with a bounded pixel sample.
- Use fast compression and no context takeover, following the terminal transport
  pattern. Browser-native inflation preserves existing application wire messages.
- Preserve uncompressed clients, protocol validation, frame ordering, ownership,
  queue byte accounting, pressure/visibility control and session lifecycle.
- Measure bitmap wire savings and compression cost, including poorly compressible
  data, rather than assuming all desktops compress well.
- Extend the combined manual checklist. No in-page RDP proxy compression,
  terminal/glyph work, codec changes or authentication changes.
- Approval: the user explicitly selected “Bitmap compression anyway.”

## Acceptance criteria

- [x] Negotiating clients receive eligible bitmaps compressed and decoded bytes
  match exactly; non-negotiating clients continue to receive ordinary messages.
- [x] H.264, small/noisy-looking bitmaps and control/end messages remain uncompressed, including
  immediately after a compressed bitmap.
- [x] Frame order, unchanged bitmap pixels and pressure/lifecycle behavior pass
  relevant regression tests and actual browser WebSocket checks where available.
- [x] Benchmarks record wire bytes, CPU/allocations and limitations across
  compressible and noisy bitmap workloads.
- [x] Documentation and the combined live checklist are updated; live remote
  desktop/iPad acceptance is not claimed without performing it.

## Verification

- `go test ./...`: passed. The opt-in browser test skips without its environment;
  it was also explicitly run as described below.
- `go test -race ./internal/rdpsession ./internal/httpapi`: passed.
- `go vet ./...`, `npm run build:web` and `git diff --check`: passed.
- `node --test web/*.test.mjs`: **998 passed**.
- Negotiated/non-negotiated socket tests check exact application bytes, raw RSV1
  flags, no context takeover, threshold transitions, and bitmap → noise → H.264 →
  bitmap → end-message transitions. Compression selection is read-only and
  allocation-free, including exact 1/8 repetition and byte-threshold boundaries.
- Actual authenticated kept-view endpoint tests cover both ordinary and
  negotiated sockets. Valid visibility/pressure messages precede invalid input;
  oversized decoded/wire input closes with 1009, while exactly-at-limit malformed
  input reaches protocol validation (1002). The kept session remains active.
- `go test ./internal/httpapi -run '^TestKeptRDPCompressionInBrowsers$' -v -count=1`
  with `TESSERA_PLAYWRIGHT` and `PLAYWRIGHT_BROWSERS_PATH` set: passed in
  **Chromium 158.0.8127.18** and desktop **WebKit 27.2**. Each browser tested both
  raw and negotiated sockets through the production viewer: 66,744 exact canvas
  pixels, four ordered messages and 256,045 identical application bytes per case.
  This is synthetic browser interoperability, not real RDP/iPad acceptance.

## Implementation notes

- Task created before implementation; reviewing the terminal transport precedent.
- Initial unconditional bitmap compression exposed severe synthetic RGB-noise
  CPU costs. Added bounded selection within the bitmap-only scope: sample at most
  512 adjacent pixel pairs across a message and require at least 1/8 to repeat.
  No allocations or persistent/adaptive state; H.264/control messages bypass it.
  This conservative heuristic can miss compressible images or select mixed noisy
  ones; it is not a guaranteed latency or compression-ratio bound.
- `internal/httpapi/rdp_kept_view.go`: negotiates permessage-deflate at the existing
  authenticated/same-origin endpoint; writes selected bitmaps with
  `flate.BestSpeed`, no context takeover. Compression resets on every message
  selection, so H.264/control writes cannot inherit it from a preceding bitmap.
  Existing frame ownership/order, original-byte queue accounting, pressure,
  visibility and lifecycle handling are retained. No browser production changes.
- Negotiating compression also permits compressed client messages. Gorilla's
  read limit counts wire payload, so `NextReader` plus a 64 KiB + 1 decoded bound
  prevents oversized inflation before viewer-message validation.
- Added Go regression/benchmark coverage in `rdp_compression_test.go` and an
  opt-in actual-browser fixture in `scripts/rdp-compression-browser-smoke.mjs`.
  WebKit initially exposed an untouched transparent canvas background in the
  smoke fixture, also in raw mode; explicitly pre-filling a known background
  fixed the fixture without changing production rendering.
- Updated `docs/vnc-and-rdp.md`, `CHANGELOG.md` and the combined performance
  acceptance checklist. Browser **from host** bytes remain inflated application
  bytes and cannot directly demonstrate wire-bandwidth savings.

## Performance tradeoffs

Synthetic component measurements on Apple M5 Max / macOS arm64. They include no
remote server, TLS transport, network throttling or physical iPad. No whole-session
latency, bandwidth, battery or unchanged-performance claim follows from them.

Initial unconditional `BestSpeed` compression reduced 1080p RGB noise with fixed
alpha to a wire ratio of 0.8558, but its median loopback round trip rose from about
1.00 to 44.05 ms (4K: about 4.05 to 180.96 ms). Random RGBA expanded slightly:
8,294,419 → 8,296,311 wire bytes at 1080p. These results motivated the sample guard,
not a claim that compression helps every bitmap. The final policy sends both
noise fixtures raw; mixed images that pass the heuristic may still be expensive.

Final benchmark command: `go test ./internal/httpapi -run '^$' -bench
'^BenchmarkKeptRDP(Bitmap|H264)' -benchmem -benchtime=500ms -count=3`.
Numbers below are medians of the three repetitions. “Raw” means a client without
compression negotiation; “selected” means the same production write path with
negotiation and the sample guard. The benchmark label `deflate` means negotiation
is enabled, not that every bitmap is actually compressed.

| Synthetic bitmap | Wire bytes raw → selected | Loopback round trip raw → selected |
| --- | --- | --- |
| 320×200 text | 256,019 → 5,487 | 0.102 → 0.319 ms |
| 1080p text | 8,294,419 → 254,295 | 1.58 → 7.27 ms |
| 4K text | 33,177,619 → 1,001,480 | 6.23 → 27.03 ms |
| 1080p RGB noise | 8,294,419 → 8,294,419 | 1.71 → 2.08 ms |
| 1080p RGBA noise | 8,294,419 → 8,294,419 | 2.10 → 2.10 ms |
| 4K RGB noise | 33,177,619 → 33,177,619 | 7.27 → 6.66 ms |
| 4K RGBA noise | 33,177,619 → 33,177,619 | 6.23 → 6.21 ms |

Text fixtures save about **97%** of wire bytes, but add compression/inflation time
on loopback; constrained-network benefit remains to be tested. Noise fixtures
stay raw, avoiding the prior forced-compression costs without a bandwidth saving.
Raw loopback timings also vary (e.g. 4K RGB-noise repetitions: 4.89–7.52 ms), so
neither apparent speedups nor smaller raw/selected differences establish a
real-world performance change. Raw mode still executes the same bounded selector.

At 1080p the selection medians are **0.607 µs text / 0.650 µs RGB noise /
0.661 µs RGBA noise**, with zero bytes and allocations per operation. H.264 and
control messages return before sampling. The isolated forced-deflate codec test
(which intentionally bypasses selection) reports 1080p medians of **5.86 ms text,
30.22 ms RGB noise and 8.05 ms RGBA noise**, with warmed allocation counts rounding
to zero per operation. These codec costs do not include browser inflation.

Loopback allocations include the Go client reading/inflating and byte-comparing
the entire message, not just server compression. Text 1080p reports about
**17.1 → 22.3 MB/op**, **32 → 61 allocations/op**; 4K about **76.9 → 77.9 MB/op**,
**36 → 63 allocations/op**. Noise remains at 32 allocations/op for 1080p and 36
for 4K in both modes. This does not measure browser/native app memory.

The 64 KiB H.264-payload transport benchmark reports the same **65,546 wire bytes**,
about **138,193 B/op** and **19 allocations/op** in both modes. Median round trips
were **44.31 µs raw / 46.49 µs negotiated** (roughly 5% higher in this run).
Compression is never invoked for it and Gorilla retains its uncompressed server
write fast path; this synthetic test does not prove identical timing, decoder
performance or end-to-end latency. Live H.264 acceptance remains on the checklist.

Raw final output is retained at
`/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/tessera-rdp-compression-final.txt`.
An earlier 200 ms guarded run is in `tessera-rdp-compression-guarded.txt` in the
same directory. The benchmark fixtures are generated and contain no user screens.

## Deferred live acceptance

Use [the combined checklist](../docs/performance-acceptance.md) for tasks 254–257
in one hands-on block, as requested:

- [ ] Real trusted RDP bitmap-fallback session: text/flat and photographic/moving
  content, wire bytes, host CPU, input latency, partial updates and resolution changes.
- [ ] H.264/AVC444 and bitmap transitions, including slow-network/CPU pressure,
  takeover, detach/reattach and background/foreground recovery.
- [ ] iPad Safari/native WKWebView negotiation, pixels, responsiveness and combined
  terminal/RDP workload. Do not weaken security to force bitmap mode.

No live-server or physical-device acceptance is claimed; no commits or pushes.
