# Task 279: SGR-Pixels mouse reports (mode 1016)

Status: implemented, awaiting manual check in a real Textual app (2026-11-24).

## Request

The user runs a Textual application in a Tessera terminal and mouse tracking
does not work correctly; they asked for mode 1016 support.

Cause: Textual queries in-band size reports (`CSI ? 2048 $ p`). Tessera
supports them, so Textual turns on SGR-Pixels (`CSI ? 1016 h`) and divides each
reported coordinate by the cell size from the 2048 report. Tessera always sent
cell coordinates, so clicks and hovers landed near the top-left cell.

## Scope

- While the program has mode 1016 set, the browser sends SGR mouse reports in
  1-based pixel coordinates, in the pixel space the host reports to the program
  (cols × accepted cell width, rows × accepted cell height), not the browser's
  CSS pixels.
- The browser terminal remembers the host-accepted cell size from the attach
  message and geometry events.
- Covers presses, releases, drags, hover motion, wheel, taps, and the phone
  scroll-mode wheel reports.
- Reports stay one per cell for drags and hover (existing flood protection).
- No change to server-side mode gating, which only reads the button code.
- Approval: the user asked for mode 1016 support directly ("can you add
  support for mode 1016?"), which is this scope.

## Acceptance criteria

- [x] With mode 1016 set, a press at cell (col, row) is reported at a pixel
      position inside that cell, which Textual's divide-by-cell-size maps back
      to the same cell.
- [x] Without mode 1016, reports are unchanged cell coordinates.
- [x] Pixel coordinates use the host-accepted cell size, falling back to the
      local renderer metrics before any host geometry is known.
- [x] Phone scroll-mode wheel reports honour mode 1016.
- [x] CHANGELOG entry.

## Verification

- `node --test web/terminal-input.test.mjs web/phone-scroll-mode.test.mjs web/terminal-entry.test.mjs`:
  62/62 pass (new coordinate test, phone 1016 wheel case, host cell size from
  `applyGeometry` and `restoreSnapshot`).
- `node --test web/*.test.mjs`: 1077/1077 pass.
- `npm run build:web`: succeeded; `web/vendor/terminal.js` regenerated.
- `go test ./internal/httpapi/ ./internal/terminal/`: pass (no Go changes).
- Scratch script against `internal/terminalcore/ghostty-vt.wasm`: `getMode(1016)`
  is 0, then 1 after `CSI ? 1016 h`, then 0 after `CSI ? 1016 l`.
- All checks are automated or mocked. Not yet checked with a live Textual app in
  a browser (pending, user).
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: clicks with 1000+1006+1016 report host pixels (`CSI < 0;90;92 M` for page (100,100), Ctrl+right `CSI < 18;117;111 M`). Not yet tried with a Textual app (not installed).

## Implementation notes

- Textual 8.2.8 `_xterm_parser.py`: `x = (px - 1) / (width_px / cols)`, and it
  drops negative results, so pixel coordinates are 1-based.
- `web/terminal-input.mjs`: `terminalMouseCoordinates` (cell + optional pixel)
  and `terminalMouseSequence` (SGR text). Used by
  `web/terminal-input-bridge.mjs` (`terminalMousePosition`,
  `sendTerminalMouseSequence`) and `web/phone-workspace.mjs`
  (`scrollPhoneSelection`).
- `web/terminal-entry.js`: `hostCellWidth`/`hostCellHeight` set in
  `applyGeometry` and `restoreSnapshot` (attach message `cellWidth`/`cellHeight`).
- Docs: `docs/terminal.md`, `docs/terminal-core.md`.
- Follow-up, not done: the core still answers DECRQM `CSI ? 1016 $ p` with 0
  (`scripts/patch-terminal-core.mjs`, `internal/terminalcore/core.test.mjs`).
  Answering it from the mode table needs Zig 0.15.2 (not installed) and a core
  rebuild, which changes the core ID. Textual does not query 1016, so it is not
  needed for this fix.
