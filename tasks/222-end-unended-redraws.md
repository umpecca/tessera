# Task 222: End redraws a program leaves open

Status: complete (iPad check pending)

## Request

Turn synchronized output off a second after a program starts a redraw it
never ends, as Ghostty does, instead of leaving it on (task 221).

## Findings

- With task 221 alone, a mode left on (a program that crashes or is
  suspended mid-redraw) stayed on in the host's core until a reset. Every
  browser that attached or reopened the pane got it on in its snapshot and
  held painting for a second, and DECRQM went on reporting it on.
- Ghostty restarts a one-second timer each time the mode is turned on and
  turns the mode off when it fires.
- The host's core and every browser's core must end it at the same point in
  the output. Writing `CSI ? 2026 l` into the output would do that, but the
  timer can fire in the middle of an escape sequence the program is still
  sending, and the bytes would join the program's output in scrollback.
  State events already carry host actions in output order (geometry,
  colour scheme, image settings).
- Because the host's timer restarts with every redraw, redraws arriving
  back to back may never let it fire, so the browser keeps its own limit on
  how long it holds painting.

## Changes

- `internal/terminalcore/source/report_api.zig`,
  `scripts/patch-terminal-core.mjs`: `tessera_synchronized_output_starts`
  counts the mode being turned on (including while on);
  `tessera_end_synchronized_output` turns it off and says whether it was
  on. `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `01a79eb74dd259350227161e7c3470da96d65a1fd7750d1fc04f837b9944dfc3`; rebuilt
  again in task 223);
  `web/vendor/terminal.js` rebuilt with it.
- `internal/terminalcore/core.go`: `SynchronizedOutputStarts`,
  `EndSynchronizedOutput`.
- `internal/terminal/synchronized.go`: after each publish, a new start
  restarts a one-second timer; when it fires for the latest start with the
  mode still on, the host's core ends it and publishes
  `StateSynchronizedOutputEnd` (kind 8, no payload). `manager.go`: the
  session's fields; `Close` stops the timer. `state.go`: the kind.
- `web/terminal-replica.mjs`: kind 8 calls `endSynchronizedOutput`, in
  order with output. `web/terminal-entry.js`: `endSynchronizedOutput` ends
  the mode in the browser's core and asks for a paint.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`; a note in task 221.

## Validation

- `internal/terminal/synchronized_test.go` (`-race`, three runs): a redraw
  that ends sends nothing; one left open is ended after the timeout, timed
  from its latest start, with an event and no payload, and DECRQM then
  reports it off; nothing more follows; no event after the session closes.
- `internal/terminalcore/core.test.mjs`: starts counted, including a start
  while on, ends not counted; ending reports whether the mode was on, and
  DECRQM reports it off.
- `web/terminal-replica.test.mjs`: kind 8 applies between the output
  around it, and is refused with a payload.
- `web/terminal-entry.test.mjs`, with the real core: the end asks for a
  paint, ends the hold and turns the mode off in the browser's core.
- Full JavaScript suite: 734 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome, a program that turned the mode on, drew a line and never
  turned it off:
  - the line was first painted about a second after the command was typed;
  - the browser's core had the mode off, and the program's own DECRQM 2.5
    seconds in got `ESC[?2026;2$y`;
  - after a page reload the snapshot had it off and the line showed at once.

  No page errors.
- Not yet tried on the iPad.
