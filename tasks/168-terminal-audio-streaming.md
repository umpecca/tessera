# Terminal audio streaming

Status: completed (platform playback limits noted below)

Extend terminal audio with incremental Opus streaming from files or stdin.
Use installed FFmpeg on the helper machine; default to 128 kbps. Carry the
requested startup/rebuffer target in the protocol, 100–2000 ms (default 500).
Clients joining, enabling, or unmuting listen at the live position. Stream
payloads never enter terminal output history, snapshots, or retained replay.
Keep clip v1, local mute, hidden playback, mixing limits, and Audio station
independence. Bound host/client queues and release encoder/decoder resources
on termination. Validate Go, JS, real FFmpeg/browser streaming, and builds.

## Implemented

- OSC v2 start/data/end/abort commands with generation tokens, ordered 100 ms
  Opus batches, pre-skip/end-padding, and a protocol buffer target. The v1
  capability reply advertises streaming; clip and terminal-state versions stay
  unchanged. No database migration is required for streaming.
- Host ingress filtering removes stream bytes before native parsing, terminal
  history, state events, or snapshots. Bounded live queues retain decoder setup
  only for current streams, enabling live joins and recovery after overflow.
- `tessera-audio stream <file|->` uses installed FFmpeg/libopus incrementally,
  with bitrate 16–256 kbps (default 128) and buffer 100–2000 ms (default 500).
  Cancellation aborts only that producer generation and stops FFmpeg.
- Pinned `opus-decoder` 0.7.12 runs in an explicitly bundled worker. Streaming
  shares Web Audio gains, mute/enable controls, voice limits, decode slots,
  encoded/PCM budgets, and cleanup with clips. Protocol and install details are
  documented in `docs/terminal-audio.md`; license notices ship with the bundle.

## Validation

- Full uncached Go suite and `go vet ./...` passed. Affected suites passed again
  after final parser/queue changes. Real FFmpeg stdin, CLI validation, Ogg
  framing, cancellation, split/cancelled OSC, bounded queues, and snapshot/history
  exclusion are covered. A real PTY/WebSocket test exercises three initially
  hidden listeners, live joins, ordered packets, and EOF.
- Full JavaScript suite passed 543 tests. Focused streaming/clip suites passed
  after final cancellation changes, including startup/rebuffer targets,
  disabled/muted joins, asynchronous stop races, queue/PCM/voice limits, and EOF.
- Windows helper runs; CGO-free Linux amd64/arm64 and Darwin arm64 builds pass.
  `node scripts/build-web.mjs` and the pinned Zig core reproducibility check pass.
  Core SHA-256 remains
  `d6df7f944f8828abcef7b285cb6d295863c037c1a7d787d26d90cfba44a3f9bd`.
- Chrome 154.0.8037.98 real-app smoke passes an 18-second FLAC-to-Opus stream,
  rendered audio signal, hidden playback, live unmute/reconnect, EOF cleanup,
  and existing WAV/MP3 clip checks. Results are in
  `.cache/review/terminal-audio-168/results.json`. These are measured browser
  output checks, not a claim of physical listening.
- Firefox, Safari, and macOS native preview playback are unverified in this
  Windows session. The earlier Firefox test runtime failed Windows side-by-side
  `mozglue` assembly loading; Safari/macOS preview are unavailable here.
