# Task 280: Mouse reports in the format the program asked for

Status: implemented, awaiting a live check in a browser (2026-11-24).

## Request

Item #1 from the mode review after task 279: Tessera always sends SGR mouse
reports (mode 1006), even to programs that never turned 1006 on. Those
programs expect the default X10 encoding (`ESC [ M Cb Cx Cy`) and misread
clicks. Tessera's default `TERM=xterm-256color` has `kmous=\E[M` in this
Mac's terminfo, so ncurses programs such as htop and mc ask for X10 reports.
The user said "lets do #1 first".

## Scope

- The browser keeps sending SGR reports (cells, or pixels under 1016 from
  task 279). The host, which already tracks the program's mouse modes from PTY
  output and gates reports, re-encodes each allowed report for the program:
  - 1016 set: SGR pixels, unchanged.
  - else 1006: SGR, unchanged.
  - else 1015 (urxvt): `ESC [ 32+code ; col ; row M`.
  - else 1005 (UTF-8): `ESC [ M` + UTF-8 of 32+code, 32+col, 32+row.
  - else X10: `ESC [ M` + bytes 32+code, 32+col, 32+row; dropped beyond
    column or row 223, as Ghostty does.
  - Legacy formats (1015, 1005, X10) report every release as button 3 with
    the modifier bits, and have no separate release final byte.
- A full reset (`ESC c`) clears the tracked mouse modes, so a program started
  after `reset` is not sent the previous program's format.
- Out of scope: mode 9 (X10 compatibility tracking), DECRQM answers for 1005,
  1015 and 1016 (need a core rebuild), browser changes.
- Approval: the user chose item #1 ("lets do #1 first"), which is this scope.

## Acceptance criteria

- [x] With 1000 set and no format mode, a press, release, drag and wheel reach
      the program as X10 bytes; a report beyond cell 223 is dropped.
- [x] 1015 and 1005 produce urxvt and UTF-8 reports.
- [x] 1006 and 1016 reports pass through unchanged (no regression).
- [x] Format precedence 1016 > 1006 > 1015 > 1005 > X10, matching the
      browser's 1016 choice.
- [x] Gating (press/drag/motion by 1000/1002/1003) still applies to every format.
- [x] `ESC c` clears tracked modes.
- [x] Docs and CHANGELOG updated.

## Verification

- `go test ./internal/terminal/ -run Mouse -v`: 6/6 pass, including new
  `TestMouseModeTrackerEncodesTheFormatTheProgramAskedFor` (17 cases),
  `TestMouseModeTrackerFullResetClearsModes` and
  `TestManagedSessionWritesX10MouseReportsForPrograms`.
- `go vet ./internal/terminal/`: clean. `go test ./...`: all packages pass.
- Premise check (real program, no Tessera): Python curses with
  `mousemask(ALL_MOUSE_EVENTS | REPORT_MOUSE_POSITION)` under
  `TERM=xterm-256color` via `script` emits `CSI ? 1000 h` and no format mode,
  so it expects X10.
- All checks are automated. Not checked live: clicking in an ncurses program in
  Tessera in a browser (pending, user).

## Implementation notes

- Precedence instead of Ghostty's "last format set wins": the browser picks
  pixel coordinates from the 1016 mode bit, and the host must agree with it.
  They differ only when a program sets several formats in an unusual order.
- Changed files: `internal/terminal/mouse_modes.go` (tracks 1005, 1006, 1015,
  1016; `encode`; `parseSGRMouseReport`; RIS clears modes),
  `internal/terminal/manager.go` (`WriteMouse` writes the encoded report),
  `internal/terminal/manager_test.go`, `docs/terminal.md`,
  `docs/terminal-core.md`, `CHANGELOG.md`. No browser changes.
- Follow-up, not done: DECRQM still answers 0 for 1005, 1015 and 1016
  (`scripts/patch-terminal-core.mjs`); needs Zig 0.15.2 and a core rebuild.
