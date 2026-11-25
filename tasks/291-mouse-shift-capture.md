# Task 291: Programs receive Shift+click (XTSHIFTESCAPE, CSI > 1 s)

Status: implemented, awaiting a live check (2026-11-24).

## Request

Sweep item: Shift with the mouse is always Tessera's text selection, even when a program asks for Shift-clicks with `CSI > 1 s`. The core records it (`flags.mouse_shift_capture`, in snapshots). The user chose sweep items #1-#4 ("lets do #1, #2, #3, #4").

## Scope

- Core export of whether the program asked to capture Shift.
- Browser: `terminalShouldReportMouse` reports Shift mouse events (with the Shift bit) while it is set; Cmd-drag (macOS) and Ctrl-drag still select. `CSI > 0 s` and reset give Shift back.
- Built in one core rebuild with tasks 289-292 (one core ID change).
- Approval: the user chose this item from the listed sweep items.

## Acceptance criteria

- [x] With `CSI > 1 s`, Shift+click is reported with modifier bit 4.
- [x] Without it, Shift still selects as now.
- [x] Docs and CHANGELOG updated.

## Verification

- `internal/terminalcore/core.test.mjs`: the flag for `CSI > 1 s`, cleared by
  `CSI > 0 s` and RIS, carried by a snapshot.
- `web/terminal-entry.test.mjs`: `mouseShiftCapture()` from the real core.
- `web/terminal-mouse-shift.test.mjs` (new): `terminalShouldReportMouse`
  reports Shift only with capture; Command and Ctrl still select.
- Not tested in a browser (pending, user).
- One core rebuild for tasks 289-292: `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`,
  core `4905925479f658c48b66a58b60eb8c3195c3a1b203f95382be78f552b74cd288`;
  `--check` matches. The first build failed: the new `CSI ! p` parser text has
  a `'$'` literal, which `String.replace` read as a `$'` pattern; added
  `spliceOnce` (literal split/join) to `scripts/patch-terminal-core.mjs` for it.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1165/1165;
  `go test ./...`: pass; `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`:
  clean; `npm run build:web`: succeeded.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: with 1000+1006 and `CSI >1s`, Shift+click reported `CSI < 4;13;6 M`; without it Shift+click was not reported.

## Implementation notes

- Core: `mouse_shift_capture` in `report_api.zig`, exported as
  `tessera_mouse_shift_capture` (1 only for `.true`).
- Browser: `mouseShiftCapture()` in `web/terminal-entry.js`;
  `terminalShouldReportMouse` in `web/terminal-input-bridge.mjs`. The Shift
  bit (4) comes from the existing `terminalMouseEventCode`.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
