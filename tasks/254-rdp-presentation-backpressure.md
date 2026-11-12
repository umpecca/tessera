# Task 254: Bound RDP presentation backlog

Status: implementation and automated verification complete (2026-11-11);
live-server and physical-device acceptance pending.

## Request

Fix the unbounded decoded-picture queue behind asynchronous AVC444 plane copies,
and propagate browser pressure to the host rather than measuring only socket
writes. A mocked blocked-copy reproduction retained 200 VideoFrames while the
existing stats reported no waiting pictures.

## Scope

- Bound decoder admission and retain asynchronous presentation work in an
  explicit, bounded, ordered queue, including surface operations.
- Report browser backlog with high/low watermarks; combine it with existing
  network backpressure and visibility suppression for kept sessions.
- Close retained pictures promptly on shutdown and prevent late asynchronous
  work from drawing after close.
- At a hard backlog limit, end the view safely rather than skipping dependent
  H.264 pictures or surface operations. Kept views use existing reattachment;
  in-page sessions must offer a clear reconnect path because their IronRDP API
  has no video-suppression call.
- Recover after five seconds without presentation progress while backpressured;
  a server honoring the soft pause may otherwise prevent reaching the hard limit.
- Expose presentation backlog in the stats overlay and document behavior.
- No terminal rendering, RDP payload-copy or bitmap-compression changes.
- Approval: the user explicitly approved performance item #1 and requested
  continuing the RDP implementation with a task file.

## Acceptance criteria

- [x] A blocked AVC444 copy cannot accumulate unbounded decoded pictures or
  promise-chain entries; queued input is also bounded.
- [x] Normal pictures, AVC444 main/auxiliary pairs and surface operations retain
  their original order without arbitrary delta-frame dropping.
- [x] Kept sessions pause for browser pressure and resume only after both browser
  and network pressure clear, without overriding hidden-window suppression.
- [x] Close, overflow, decoder errors and late asynchronous completions release
  resources safely; replacing a viewer does not inherit old pressure.
- [x] Stats and documentation describe the new queue and recovery behavior.
- [x] Regression tests and relevant JavaScript/Go validation pass, with any
  unperformed live-server or physical-device checks recorded explicitly.

## Verification

- `node --test web/*.test.mjs`: **986 tests passed** on the final changes.
- `go test ./...`: passed, including the embedded web-module checks.
- `go test -race ./internal/httpapi ./internal/rdpsession`: passed.
- `go vet ./...`: passed.
- `npm run build:web`: passed; generated vendor assets stayed unchanged.
- `git diff --check`: passed. Go files formatted with `gofmt`.
- Go was absent from PATH; used the existing Go toolchain at
  `/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode/tessera-go-1ovo0srj/go/bin/`.
- Presenter tests use mocked WebCodecs and controlled plane-copy promises. The
  blocked-copy case reaches 64 outstanding decoded pictures, rejects the next
  admission, closes every retained picture immediately and performs no late
  draw after the blocked copy resolves. This establishes queue bounds, not a
  measured browser memory ceiling or an end-to-end performance improvement.
- Regression coverage includes hysteresis, byte/operation bounds, missing decoder
  output, the no-progress watchdog, picture/main/auxiliary/surface-copy ordering,
  close during a pending copy (resolve and reject), and stale decoder errors.
- Viewer tests cover pressure messages, preserving the host session on overflow,
  and the explicit in-page reconnect message before and after connection.
- Host tests cover validation through a real loopback WebSocket, independent
  browser/network pressure, draining the socket while browser pressure remains,
  and fresh viewer state. Existing session tests cover hidden-window suppression
  and ignoring pressure reports from a replaced viewer.

## Implementation notes

- Created this task before application changes, following `AGENTS.md`.
- `web/rdp-h264.mjs`: replaced the unbounded promise chain with an explicit FIFO
  and shared lifecycle tracking across decoder-pending, queued and active work.
  Bounds are 64 pictures, 256 total entries and 16 MiB of encoded payload/region
  metadata. The byte accounting is not decoded-pixel memory accounting.
- Pressure starts at 8 pictures, 32 entries or 1 MiB and clears at no more than
  2 pictures, 8 entries and 256 KiB. A five-second watchdog resets on presentation
  progress and recovers a pressured pipeline even when no more video arrives.
- Removed guessing that missing decoder output could be skipped safely. Hard
  overflow or a pressured stall closes the view instead of selectively dropping
  dependent pictures/operations. Close promptly releases retained VideoFrames,
  queued references, plane scratch and SPS cache; late async work cannot paint.
- `web/rdp-viewer-wire.mjs`, `web/rdp-viewer.mjs`,
  `internal/rdpsession/viewer_protocol.go`, `internal/httpapi/rdp_kept_view.go`:
  added viewer-level `ViewPressure [behind u8]`. Host pressure is the OR of network
  and browser state and uses the existing identity-checked session pause path.
  Visibility remains an independent requirement for resuming video.
- Kept-session hard overflow/stall closes only the viewer and uses existing
  automatic reattachment. `web/rdp-session.mjs` disconnects in-page sessions with
  an explicit Connect/disable-full-color message because they cannot suppress
  upstream video through the current IronRDP API.
- `web/rdp-stats.mjs` shows compositing count and a behind indicator, without
  suggesting that in-page video has actually paused. Updated `docs/vnc-and-rdp.md`
  and `CHANGELOG.md`.

## Live acceptance still required

Use [the combined terminal/RDP checklist](../docs/performance-acceptance.md) to
perform this task and task 255's hands-on acceptance in one testing block.

- [ ] Real Remotr/Windows server: verify pause/resume, fresh display on recovery,
  and AVC420/AVC444 rendering during sustained activity and network throttling.
- [ ] iPad Safari/WKWebView: check decoder/copy throughput, retained-frame memory,
  responsiveness, background/foreground transitions and several active panes.
- [ ] Tune watermarks/watchdog only with real-device evidence if normal workloads
  cause excessive full-screen refreshes or repeated viewer reattachments.

No live RDP credentials or personal remote sessions were used. No end-to-end
speedup, physical-device memory ceiling or hardware release sign-off is claimed.
