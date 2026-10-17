# Task 190: Echo latency breakdown and cheap prediction reads

Status: complete

## Request

On the iPad, Settings → Diagnostics reported a 44 ms echo while the network
round trip measured 26-27 ms (tasks 188 and 189). Break down the extra
~17 ms.

## Findings

- **Host:** a loopback harness (Go, keystroke to echo frame over Tessera's
  terminal websocket) measured zsh plus Tessera's server at 0.45 ms p50
  (raw zsh in a PTY 0.15 ms; PTY read to websocket send 0.09 ms). Not the
  host.
- **The 44 ms was the smoothed average.** With a per-stage breakdown added
  (below), the iPad showed a 31 ms median echo: 0.0 ms before sending, 26 ms
  until the reply is handled (the network round trip exactly, so no
  main-thread wait), and **5.0 ms applying** a one-character echo.
- **Cause:** the prediction check read cells with ghostty-web's
  `getLine(row)`, which refreshes the render state, copies and parses the
  *whole viewport* out of WASM, and then returns one row. It ran twice per
  keystroke: after the echo (the 5 ms) and in `predictInput`, before the
  keystroke is sent, which the breakdown missed because the timestamp was
  taken after it. Profiled in headless Chrome on the Mac at 164x45:
  `getLine` 621 µs per call against 41 µs for the terminal write itself.

## Changes

- `web/terminal-entry.js`: `predictionScreen().cellAt` reads one cell with
  `getGrapheme(row, col)` from the render state `getCursor` has just
  refreshed. It matched `getLine`'s codepoint for text, colored text, empty
  cells, spaces, erased cells and both halves of a wide character.
- `web/terminal-prediction.mjs`: a prediction's time is taken when input
  handling starts, so reading the screen counts as time before sending.
  The engine keeps the last 64 confirmed echoes split into before sending
  (`noteSent`), until the reply is handled (`noteArrival`), and applying,
  and reports their medians (`latencyBreakdown`).
- `web/app.js`: input calls `noteInputSent` after the socket send; binary
  terminal messages call `noteOutputArrival` before they are applied.
  Diagnostics append the medians to the Typing prediction line, for
  example `last 64 echoes, medians: 31 ms total, 0.0 ms before sending,
  26 ms until the reply is handled, 5.0 ms applying`.
- `web/vendor/terminal.js` rebuilt.

## Validation

- Engine tests for the breakdown (stage medians; a reply handled before the
  send is not split) and the diagnostics wording; the terminal hook test
  now fakes `getGrapheme`. Full JavaScript suite: 624 pass.
- Headless Chrome on the Mac, 164x45 terminal, 220 typed keys, per-call
  wrappers: prediction check 558 → 61 µs, input prediction 790 → 98 µs,
  applying median 0.6 → 0.1 ms.
- iPad (Safari 27, Tailscale): confirmed working by the user after the fix.

## Notes

Safari reports `performance.now()` in 1 ms steps, so sub-millisecond stages
on the iPad read as 0 or 1 ms.
