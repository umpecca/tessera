# Task 285: X10 compatibility mouse tracking (mode 9)

Status: implemented, awaiting a live check (2026-11-24).

## Request

Item #5 from the mode review after task 279: a program that turns on only
mode 9 gets no clicks. The browser asks Ghostty's `has_mouse_tracking`,
which reads only 1000, 1002 and 1003, and the host's gate passes reports only
for those modes. The user said "lets do #4 and #5".

## Scope

- Browser: the terminal's `hasMouseTracking` also counts mode 9, so clicks
  are reported (and not taken as text selection) in such programs.
- Host (`internal/terminal/mouse_modes.go`): track mode 9; with mode 9 and
  none of 1000/1002/1003, pass only presses of the left, middle and right
  buttons, without modifier bits, as Ghostty's encoder does; no releases,
  drags, motion or wheel. The report format (X10 bytes, 1005, 1015, SGR)
  still follows task 280.
- With 1000, 1002 or 1003 also set, those win (precedence, as for formats).
- Approval: the user asked for #5 directly.

## Acceptance criteria

- [x] Mode 9 alone: a Ctrl+left press reaches the program as a plain left
      press (X10 bytes by default); release, drag, motion and wheel do not.
- [x] Mode 9 with 1000: normal-tracking behaviour.
- [x] The browser reports clicks with only mode 9 set.
- [x] Docs and CHANGELOG updated.

## Verification

- `go test ./internal/terminal/ -run Mouse`: new
  `TestMouseModeTrackerX10CompatibilityReportsPressesOnly` (presses only,
  modifiers stripped, X10 and SGR formats, 1000 wins, reset).
- `node --test web/terminal-entry.test.mjs`: new test that mode 9 counts as
  mouse tracking.
- `go test ./...`: pass; `go vet ./internal/terminal/`: clean.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1144/1144;
  `npm run build:web`: succeeded, override in `web/vendor/terminal.js`.
- Not checked live with a mode-9 program (pending, user).
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: mode 9 reported presses only, Ctrl stripped (`CSI M "-&` for Ctrl+right), no releases.

## Implementation notes

- Host: `internal/terminal/mouse_modes.go` (`x10Only`, `allows`, `encode`);
  comment in `internal/terminal/manager.go`.
- Browser: `hasMouseTracking` override in `web/terminal-entry.js`. Every
  caller (click reporting, copy guidance, phone wheel reports) now counts
  mode 9; wheel and drag reports the browser sends are dropped by the host.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
