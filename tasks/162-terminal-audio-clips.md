# Terminal audio clips v1

Status: completed (cross-browser listening checks remain platform-limited)

Implement the user-approved terminal audio plan: a namespaced OSC protocol for
embedded WAV/MP3 clips, stop and capability commands, live delivery independent
of terminal text visibility/replay, browser mixing and local mute controls, and
a portable `tessera-audio` helper. Clips are limited to 512 KiB and 10 seconds;
playback allows four concurrent clips per terminal and sixteen per page.

Validation covers native parsing/snapshots, live-only transport, bounded queues,
browser cancellation and limits, helper I/O, reproducible WASM/bundles, and
available browser smoke tests. Record platform/manual limitations explicitly.

## Implemented

- Namespaced OSC v1 play, stop, and host-only capability replies, with bounded
  native effects, fragmentation/cancellation handling, strict clip validation,
  and snapshot-safe browser effect disposal. Terminal protocol remains 2.
- Separate bounded attachment queues and WebSocket opt-in, including initially
  hidden listeners, overflow reset, and live-only reconnection behavior.
- Independent browser mixing, decode/memory limits, asynchronous cancellation,
  page activation, persistent per-workspace/pane mute, and pane error actions.
- Portable Go helper, platform release assets, protocol/install documentation,
  reproducibly rebuilt shared WASM core and committed browser bundle.

## Validation

- `go test -count=1 ./...` passed; `go vet ./...` passed. Subsequent helper and
  transport changes passed the affected package suites again. Windows ConPTY
  tests verify raw-mode restoration on success, timeout, and interruption.
- `node --test internal/terminalcore/core.test.mjs web/*.test.mjs scripts/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs`
  passed all 524 tests after final changes, including activation/start failures.
- CGO-free helper builds passed for Linux amd64/arm64 and Darwin arm64; the
  Windows amd64 helper runs in the integration and browser smoke tests.
- `node scripts/build-terminal-core.mjs --check` and
  `node scripts/build-web.mjs` passed. Shared core SHA-256:
  `d6df7f944f8828abcef7b285cb6d295863c037c1a7d787d26d90cfba44a3f9bd`.
- Isolated real-app Chrome 154.0.8037.98 smoke passed helper discovery,
  activation, overlapping WAV/MP3, rendered audio signal (RMS 0.01243), stops,
  local mute, hidden playback, reconnect without replay, persisted mute, and
  page cleanup. Results are in `.cache/review/terminal-audio-162/results.json`.
  This measures browser audio output; it does not claim a human listening check.
- Firefox live validation could not launch the downloaded Playwright browser:
  Windows reported a side-by-side `mozglue` assembly-loading failure. Safari
  and the macOS native desktop preview are unavailable on this Windows host.
  Audible/manual checks across those browsers remain unverified.
