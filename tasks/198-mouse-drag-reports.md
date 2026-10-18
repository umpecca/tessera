# Task 198: Drag reports once per cell, and only when asked for

Status: complete

## Request

After quitting graft, a mouse-aware program the user is writing, the shell
prompt showed `32;5;5M32;5;5M32;5;5M32;5;5M32;5;5M32;5;5M0;5;5m`: SGR mouse
reports (`ESC [ <` eaten by the line editor) for six left-button drags at
column 5, row 5 and a release. They reached the PTY while graft had mouse
tracking on, and graft exited without reading them, so the shell read them.
The server's existing gate (only while a mouse mode is on) can't drop
reports written before the program turned tracking off.

Two Tessera behaviors made the pile-up larger than in a local terminal:

- Every `pointermove` during a press sent a drag report, even inside one
  cell, so a click with a slight wobble sent a run of identical reports.
  xterm reports a drag only when the cell changes.
- Drags were sent in any mouse mode, including 1000, which asks only for
  presses and releases.

## Changes

- `web/terminal-input.mjs`: `TerminalMousePress.update` returns whether the
  press moved to another cell; `web/app.js` sends a drag only then.
- `internal/terminal/mouse_modes.go`: `allows(report)` reads the SGR button
  code. Presses, releases and the wheel need any mode; drags (motion bit
  with a button) need 1002 or 1003; motion with no button needs 1003.
  Reports that aren't SGR are judged by `enabled` as before.
- `internal/terminal/manager.go`: `WriteMouse` uses `allows`.

## Validation

- `web/terminal-input.test.mjs`: a drag inside one cell reports nothing,
  each new cell once. Full JavaScript suite passes (647).
- `internal/terminal`: each report kind against no mode, 1000, 1002 and
  1003, including a modified drag and a non-SGR report. `go test` passes for
  `internal/terminal` and `internal/httpapi`.
- Not run end to end against graft.

## Not done

A program that quits on a mouse press can still leave the release (or a
drag across cells) unread: it was sent before the program's "tracking off"
reached the browser. Over a network that window is wider than locally. The
program side fix is to turn tracking off and then discard unread input
(`tcflush(fd, TCIFLUSH)`) before exiting. Tessera flushing the PTY's input
when tracking turns off would also discard typeahead meant for the shell,
so it doesn't.
