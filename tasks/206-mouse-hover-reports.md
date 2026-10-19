# Task 206: Report pointer motion without a button (mode 1003)

Status: complete (iPad check pending)

## Request

A mouse-aware app's hover effect did not work in Tessera. The app turns on
any-event tracking and SGR encoding (`CSI ? 1003 h`, `CSI ? 1006 h`),
expects `ESC [ < 35 ; col ; row M` as the pointer moves with no button held,
and underlines (SGR 4) the control under the pointer.

## Cause

The browser never sent button-less motion. The terminal's `pointermove`
handler returned at once unless a press was in progress, so only drags were
reported. Task 198 had already taught the server to pass button-less motion
only in mode 1003; nothing produced it. Mode tracking and SGR 4 rendering
were fine.

## Changes

- `web/terminal-input.mjs`: `TerminalMouseHover` reports a move only when
  the pointer enters another cell, as drags are (task 198), and forgets the
  cell on `reset`. `terminalHoverButtonCode` is 35 (motion + no button).
- `web/app.js`: in the mouse bridge, a `pointermove` with no press and no
  button held sends `ESC [ < 35 ; col ; row M` when `terminalReportsMotion`
  (`term.getMode(1003)`) and `terminalShouldReportMouse` (tracking on, no
  Shift, Ctrl or Cmd, as for clicks) allow it. Option adds 8, like other
  reports. The cell is forgotten on `pointerleave`, during a press, and
  whenever a move is not reported, so the next reported move always says
  where the pointer is. Not stopped from reaching ghostty-web, which still
  needs mousemove for link hover.
- `CHANGELOG.md`.

## Validation

- `web/terminal-input.test.mjs`: once per cell, again after reset, code 35.
  `web/terminal-selection.test.mjs`: through the real bridge, no report
  without mode 1003, one per cell with it, none with Shift, Option adds 8,
  reported again after the pointer leaves and returns. Bridge fixtures in it
  and `web/terminal-scroll.test.mjs` gained the new names. Full JavaScript
  suite: 665 pass. `go test ./...` fails only on the unembedded
  `screensaver.mjs`, as before.
- Real host and PTY, headless Chrome over the DevTools protocol, a Python
  program that enables 1003 + 1006, draws `[ Button ]` at row 2, columns
  3-12, underlines it while the pointer is over it, and logs what it reads.
  Pointer path (1,5) (2,5) (5,2) (5,2) (6,2) (20,8) (8,2) (30,10): the
  program received `35;1;5M 35;2;5M 35;5;2M 35;6;2M 35;20;8M 35;8;2M
  35;30;10M`, the repeated cell once; the button was underlined at (8,2) and
  plain again at (30,10).
- Not yet tried in Safari on the iPad. Touch has no hover; a trackpad or
  mouse pointer should report.

## Note

Any-event tracking reports far more often than drags, so a program that
exits with 1003 on, without discarding unread input, leaves more reports for
the shell to print than task 198's case. The program should turn tracking off
and then `tcflush(fd, TCIFLUSH)` before exiting.
