# Task 089: Answer Fish primary device-attribute queries

Status: complete

Fish probes terminal capabilities during interactive startup with the Primary
Device Attributes request (`CSI c` / `CSI 0 c`). Tessera's bundled
`ghostty-web` 0.4.0 parser does not generate a response for either form, so
Fish waits ten seconds and warns that optional terminal features are disabled.
The same parser does generate responses for device-status reports, and Tessera
already forwards those terminal responses to the PTY.

## Requirements

- Recognize both 7-bit Primary Device Attributes request forms emitted in PTY
  output: `ESC [ c` and `ESC [ 0 c`.
- Preserve all PTY output bytes and ordering exactly, including requests split
  across WebSocket frames and terminal-write scheduler chunks.
- Send `CSI ? 1 ; 0 c` back to the current PTY without displaying or removing
  the request from terminal output. This conservatively identifies Tessera as
  a VT100-family terminal without claiming Advanced Video Option, Sixel,
  ReGIS, printer, or other optional hardware capabilities.
- Do not answer secondary or tertiary device-attribute requests as DA1.
- Do not send a queued response to a closed or superseded WebSocket.
- Keep Ghostty's existing response path for queries it already supports.

## Verification

- Add focused tests for both DA1 forms, ordinary output, false prefixes,
  secondary/tertiary queries, split requests, and reset/disposal behavior.
- Run `node --test web/*.test.mjs`.
- Run syntax checks for changed browser modules.
- Run `npm run build:web`, `go test ./...`, and `git diff --check`.
- Start Fish in a live Tessera terminal and confirm startup completes without
  the ten-second Primary Device Attribute warning.

## Implementation

- Added a streaming DA1 recognizer beside the Ghostty Web adapter. It accepts
  only `CSI c` and `CSI 0 c`, carries partial requests across terminal writes,
  and resets partial state when the browser terminal is reset.
- The adapter passes every output byte to Ghostty unchanged and emits
  `CSI ? 1 ; 0 c` through Ghostty's non-display input path immediately after
  each completed request. Splitting a write at the request boundary preserves
  response ordering with status and cursor-position replies Ghostty generates.
- The existing dynamic `onData` bridge sends the reply only through the current
  open WebSocket, so closed and superseded connections retain their existing
  safety behavior.
- Rebuilt the committed terminal bundle and advanced its cache key.

## Verification results

- `node --test web/*.test.mjs` (156 tests passed, including seven new DA1
  parser/identity cases)
- `node --check web/app.js`, `web/terminal-entry.js`, and
  `web/terminal-device-attributes.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
- A live Fish smoke test was unavailable on this Windows host because neither
  Fish nor WSL is installed. The focused tests cover Fish's exact `CSI 0 c`
  request, the emitted identity, split input, false prefixes, and stream reset.
