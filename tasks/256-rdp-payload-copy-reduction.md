# Task 256: Reduce kept-RDP payload copies

Status: implementation and automated verification complete (2026-11-11);
live-server and physical-device acceptance deferred to the combined testing block.

## Request

Reduce redundant allocations and full-payload memory passes in kept-RDP
transport, including browser bitmap parsing, without changing wire bytes,
H.264 dependencies, rendering or backpressure behavior.

## Scope

- Audit WASM-event, session and viewer buffer ownership before removing copies.
- Remove redundant host-side payload copying while preserving a stable owned
  outbound buffer and any explicitly retained session state.
- Parse browser bitmap data without a full RGBA slice copy, and make alpha
  correction safe for the existing unaligned pixel offset.
- Preserve protocol compatibility and rendering, including opaque bitmap output.
- Add ownership/aliasing regression tests and isolated allocation/copy benchmarks.
- Extend the combined manual acceptance checklist; live remote-server/iPad tests
  remain deferred to the user's single testing block.
- No bitmap compression, codec changes, terminal rendering or credential changes.
- Approval: the user explicitly requested implementing the next optimization,
  kept-RDP payload copy reduction.

## Acceptance criteria

- [x] Queued viewer frames and retained surface state survive later WASM-memory
  reuse; ownership rules are explicit and tested.
- [x] Redundant host and browser full-payload copies are removed on the active path.
- [x] Wire bytes, bitmap colors/opacity and H.264 region/data ordering are unchanged.
- [x] Tests cover unaligned bitmap views, buffer boundaries and late processing.
- [x] Benchmarks report allocation/copy results without claiming unmeasured
  end-to-end or physical-device speedups.
- [x] Relevant validation passes and the combined live checklist is updated.

## Verification

- `node --test web/*.test.mjs`: **998 tests passed**.
- `go test ./...`: passed, including embedded-module checks.
- `go test -race ./internal/rdpsession ./internal/httpapi`: passed.
- `go vet ./...`, `npm run build:web` and whitespace checks: passed.
- Real WASM-module tests verify that synchronous callbacks borrow memory with
  capacity clamped to payload length. Queued frames, retained surface mappings
  and optional observer payloads survive both immediate memory reuse and growth.
  Observer mutation cannot change the other consumers' data.
- Allocation assertions exercise engine → connection → session → framing:
  **one allocation** per attached bitmap event without an optional observer;
  **zero allocations** when no viewer is attached.
- Browser tests verify the unaligned byte-offset-9 bitmap view aliases only its
  received message, alpha correction changes only alpha, headers/RGB remain intact,
  and later messages cannot overwrite previously retained pixels. H.264 regions
  retain correct little-endian values and independent lifetime.
- Headless **Chromium 158.0.8127.18** and desktop **WebKit 27.2** exercise the
  actual viewer with real ImageData/canvas implementations. Both passed exact
  synthetic bitmap pixels, untouched surrounding canvas pixels and unchanged
  wire-header checks. This is not live-server/iPad acceptance.

## Implementation notes

- Created this task before implementation.
- `internal/rdpsession/engine.go`: passes a borrowed, read-only module-memory
  slice through the synchronous event callback instead of first cloning it.
  `Link.Event`, connection and viewer callback ownership rules are explicit.
- `viewer_protocol.go`: makes one exact-size owned outbound allocation, writes
  its existing type byte and copies the payload directly. No framing bytes change.
- `session_run.go`: the optional NewSession observer still receives an owned
  copy. Normal HTTP kept sessions have no observer. Retained surface mappings
  already copy their bytes. Test recorders now copy borrowed events when storing
  them, following the explicit callback contract.
- `web/rdp-viewer-wire.mjs`: bitmap pixels view the received ArrayBuffer directly;
  ending-reason decoding also avoids unnecessary slices. Parsing remains read-only.
- `web/rdp-viewer.mjs`: replaces the alignment-dependent Uint32 alpha loop with
  writes to every fourth byte of the bounded pixel view. Existing image timing
  still includes alpha normalization and drawing.
- Deliberately retained the small H.264 region-metadata copy: aliasing it would
  pin the entire encoded packet until presentation finishes. Encoded video data
  still borrows its received buffer for synchronous decoder submission.
- Added `scripts/benchmark-rdp-payloads.mjs` and Go copy benchmarks. Updated
  `docs/vnc-and-rdp.md`, `CHANGELOG.md` and the combined acceptance checklist.
- No codec, compression, wire-format, terminal, WASM binary or credential changes.

## Isolated measurements

Apple M5 Max / macOS arm64. These are component allocation/copy measurements,
not whole-session throughput, network bandwidth, input latency or battery claims.

Host benchmark: `go test ./internal/rdpsession -run '^$' -bench
'^BenchmarkViewerPayloadCopies$' -benchmem -benchtime=200ms -count=3`.
The before case reproduces the old engine clone before framing; the after case
frames borrowed bytes directly. Times are medians of the three runs.

| Payload | Host allocations before → after | Time before → after |
| --- | --- | --- |
| H.264, 64 KiB | 2 → 1 | 10.70 → 5.19 µs |
| Bitmap, 1080p | 2 → 1 | 631 → 340 µs |
| Bitmap, 4K | 2 → 1 | 2.13 → 1.21 ms |

Host allocated bytes were approximately halved for large bitmaps: 1080p
16.60 → 8.30 MB/op; 4K 66.37 → 33.19 MB/op, including allocator rounding.

Browser benchmark: bitmap parsing plus alpha normalization only, with four
warmup rounds, twenty measured samples, alternating before/after order and
batched timing. Canvas rendering is checked separately, outside timing.
The baseline is the pre-task bitmap parser from repository HEAD and the old
word-based alpha loop; the current alpha loop matches the production viewer.

| Browser / bitmap | Median parse + alpha before → after |
| --- | --- |
| Chromium, 1080p | 1.45 → 0.65 ms |
| Chromium, 4K | 5.85 → 2.65 ms |
| Desktop WebKit, 1080p | 0.75 → 0.50 ms |
| Desktop WebKit, 4K | 3.00 → 2.50 ms |

The eliminated browser pixel copy is **8,294,400 bytes per 1080p bitmap** or
**33,177,600 bytes per 4K bitmap**. Typed-array view objects and the browser's
internal decoder/canvas allocations still exist. WebKit's whole-millisecond
clock limits precision even with batching; the small 320×200 case rounded to
the same median before/after there.

Raw browser results and the saved baseline are under
`/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/`:

- `tessera-rdp-payload-chromium.json`
- `tessera-rdp-payload-webkit.json`
- `tessera-rdp-wire-before.mjs`

Reproduce with `node scripts/benchmark-rdp-payloads.mjs --baseline=<path>
--playwright=<module path> [--browser=webkit] [--output=<JSON path>]`; use the
available Playwright browser installation via `PLAYWRIGHT_BROWSERS_PATH`.

## Live acceptance still required

Use [the combined checklist](../docs/performance-acceptance.md) for this task
and tasks 254/255 in one hands-on block:

- [ ] Real-server bitmap fallback: opacity, RGB colors, partial/full-screen updates
  and resolution changes, including a slow viewer catching up.
- [ ] H.264/AVC444: sustained activity, detach/reattach and cross-browser takeover
  without surface corruption or changed backpressure behavior.
- [ ] iPad Safari/native WKWebView: responsiveness, memory, foreground recovery
  and combined terminal/RDP workload.

No personal remote desktop or RDP credentials were used for automated checks.
