# Pause hidden terminal network output

Status: complete

## Request

Stop sending terminal output to minimized, fully covered, and background-tab
panes while keeping their shells and exit notices live.

## Implementation

- Pause delivery per attachment, discard its queued output, and omit new events
  from its queue. Keep lifecycle delivery open and other clients unaffected.
- Start hidden connections paused before building or transmitting a snapshot.
- Acknowledge pause after serializing it with socket writes. Frames already in
  flight may arrive, and the browser continues discarding them while hidden.
- Reveal through a new attachment. Request a snapshot if the host state changed
  while hidden; preserve the existing terminal view when it did not.
- Preserve query replies, live-only clipboard effects, retry/disposal behavior,
  shell exits, and atomic snapshot/live event ordering.
- Release transmitted or abandoned startup snapshot/replay buffers while the
  socket remains open. Protocol-2 subscriptions avoid copying a legacy replay.

## Validation

- All 444 JavaScript/core tests passed. Two new browser regressions and updated
  existing checks cover hiding an opening socket, initial hidden startup,
  duplicate visibility updates, pause acknowledgements, idle view preservation,
  changed host state without hidden output messages, incomplete reveal snapshot
  retries, stale socket callbacks, visibility, clipboard suppression, and exits.
- Seven Go regressions cover delivery query options, initially paused
  subscriptions without snapshots, host query replies and visible clipboard
  effects, queued/in-flight output cleanup, clean and failed exits, unchanged
  cursor resume, changed output and image settings, and concurrent pause,
  unsubscribe, and exit operations.
- A real local PowerShell PTY/WebSocket test generated two 2,000-line builds.
  An initially hidden connection and a previously visible connection both
  received zero output frames after pause acknowledgement. Visible peers
  received about 47–48 KiB of output per build. Reveal transferred a complete
  2,363,623-byte current snapshot of the same shell, and both paused sockets
  received its clean exit close frame. Timing and coalescing were enabled on
  the initially hidden socket; neither bypassed the pause.
- A native-core stress test published 16 MiB of progress output through 256
  ordered events. The visible subscriber received all 16 MiB, while the paused
  subscriber received no events and retained zero queued bytes. Its subsequent
  attachment used the latest snapshot instead of hidden-output replay. This
  verifies delivery and memory behavior, not compilation speed or end-to-end
  latency. The browser's real-WASM hidden recovery test also preserves history,
  images, and incomplete parser state.
- `npm run build:web`, `go test ./...`, `go vet ./...`, JavaScript syntax checks,
  and `git diff --check` passed. `go test -race` could not run: this Windows host
  has CGO disabled and no C compiler. Concurrent lifecycle coverage passes in
  the ordinary Go test run; race-detector validation remains unavailable here.

Pause acknowledgements follow already-started socket writes. Those earlier
frames can arrive after hiding and are discarded by the browser. Pausing is
per connection and resumes through a replacement attachment; shells continue
running and retaining authoritative state throughout. The native core hash and
snapshot format are unchanged.
