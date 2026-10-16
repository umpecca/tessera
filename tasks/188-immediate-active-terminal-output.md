# Task 188: Apply small active terminal output immediately

Status: complete

## Request

Look for further latency improvements.

## Findings

- Server echo path is already cheap. Per keystroke echo the host core costs
  about 0.23 µs on Apple M4 (`Write` plus the reply, clipboard, audio and file
  drains). Input is written to the PTY straight from the socket reader, and
  server output coalescing is off by default.
- Browser: every output event, even a one-byte echo, was queued in the shared
  `TerminalWriteCoordinator` and applied from a posted `MessageChannel` task.
  The browser may run a rendering step between the socket message task and
  that posted task. When it does, the echo is parsed after the frame and
  appears one frame (about 16 ms at 60 Hz) late.

## Change

`TerminalWriteScheduler.enqueueTask` runs an output event synchronously when:

- the scheduler is the active pane's,
- nothing is queued ahead of it and the coordinator is not draining, and
- the event is output (`outputBytes > 0`) within a 4 KiB budget per socket
  message. A microtask resets the budget, so a catch-up replay of many small
  events still falls back to the queue after a few kilobytes.

Control tasks (`outputBytes` 0) always queue; they include snapshot imports.
Background panes and output behind queued work keep the existing fair,
budgeted rotation. `TerminalReplica.receive` stops reading a message once an
event has disconnected the replica, since events can now fail inside the loop.

## Considered, not changed

- A desynchronized (low-latency) canvas context. The context belongs to the
  vendored renderer, and Chrome mostly ignores the hint for canvases that are
  composited with overlapping, transformed DOM such as Tessera's panes.
- Removing the server's pump goroutine hop. It saves microseconds.
- Parsing off the PTY read path (task 186). It matters only during floods.

## Validation

- New tests cover immediate active output, queued control and oversized
  tasks, ordering behind queued work, inactive panes, no immediate writes
  inside a drain, the per-message budget, and a failed event ending the loop.
  Two existing queued-path tests disable immediate writes to keep covering
  the queue.
- `node --test web/*.test.mjs`: 546 pass. `go test ./web/` passes.
- Real server with headless Chrome: echoes, a `seq 1 3000` flood, and typing
  after it all render in order with no console errors.

## Measurements

Headless Chrome 148 on Apple M4, 60 Hz frames. A page hook timestamps each
echo's arrival on the typing pane's socket and the pane's first canvas paint
after it. Two side-by-side terminals; the typing pane runs `cat >/dev/null`;
keystrokes are 40-100 ms apart. Old and new builds ran from separate servers
in alternating runs of 300 keystrokes.

| Scenario | Build | Echoes an extra frame late (≥1.5 frames to paint) | Arrival to paint, mean / p99 |
|---|---|---|---|
| Idle | before | 33 / 600 (5.5%) | 17.7 / 34.9 ms |
| Idle | after | 0 / 600 | 16.8 / 18.7 ms |
| Other pane flooding | before | 3 / 600 | 16.6 / 18.8 ms |
| Other pane flooding | after | 0 / 600 | 16.5 / 17.0 ms |

Mean keystroke-to-paint went from about 26.7 to 25.5-26.4 ms idle.

### Where the rest of the latency goes

- Server: a plain websocket client sees a 0.41 ms p50 echo round trip.
- Chrome: after a keypress, Chrome runs the next frame before other tasks, so
  the echo's socket message waits a median 9 ms for it and then paints on the
  following frame. The same send from a page timer arrives in 0.7 ms. With
  Tessera's key handlers bypassed entirely the wait is unchanged (8.9 ms p50),
  so it is browser scheduling, not Tessera's input path. Only rendering from
  a worker (`OffscreenCanvas`), which this scheduling does not hold back,
  could avoid it; that would move the renderer off the main thread and was
  not attempted. Measured in headless Chrome; Safari was not measured.

## Follow-up (tabled 2026-10-16)

The user mainly uses Safari on iPadOS and macOS, often remotely over
Tailscale from another state, and plans a native iPadOS WKWebView wrapper.
The Chrome measurements above do not establish WebKit behavior.

Next steps, in order:

1. **Measure on the iPad over the VPN.** `scripts/latency-check` is a
   standalone echo server and page (no shell access). Build it with
   `cd scripts/latency-check && go build -o /tmp/latency-check .`, run it
   bound to the Tailscale address (for example
   `/tmp/latency-check 100.125.47.118:6970`), and open it in Safari. It
   reports the network round trip, the extra wait after a keypress versus a
   timer send, the frame rate, and arrival-to-paint, and uploads results as
   `results-*.json` beside the server. Not yet run: starting the listener
   needs the user's go-ahead.
2. **Frame rate.** Safari may cap page rendering at 60 fps on ProMotion
   displays ("Prefer Page Rendering Updates near 60fps" feature flag). The
   user has an iPad Pro, so 120 fps could halve each frame wait. Confirm the
   flag, measure, and check whether a WKWebView app can enable it.
3. **Predictive local echo (mosh-style).** Over a 30-80 ms link the network
   round trip likely dominates. Draw typed characters locally at once,
   underline them until the server's echo confirms them, and suppress
   prediction when the PTY has echo off (password prompts) or in
   full-screen applications. Scope only after step 1's numbers.
4. **Worker rendering (`OffscreenCanvas`).** Only if Safari shows Chrome's
   wait after a keypress, and only after a standalone spike confirms WebKit
   presents worker canvas frames without the main thread.
