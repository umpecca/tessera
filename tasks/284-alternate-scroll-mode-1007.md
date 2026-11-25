# Task 284: Honour mode 1007 (alternate scroll)

Status: implemented, awaiting a live check (2026-11-24).

## Request

Item #4 from the mode review after task 279: on the alternate screen without
mouse tracking, Tessera turns the mouse wheel and two-finger scrolling into
Up/Down arrow keys even when the program turned alternate scroll (mode 1007)
off. The user said "lets do #4 and #5".

## Scope

- Browser wheel (`onWheel`) and two-finger touch scrolling (`scrollByTouch`)
  in `web/terminal-input-bridge.mjs`: on the alternate screen without mouse
  reporting, send arrow keys only while mode 1007 is set (its default);
  otherwise the scroll does nothing, as in Ghostty (the alternate screen has
  no scrollback).
- No change with mouse reporting, on the normal screen, or in Scroll mode.
- Approval: the user asked for #4 directly.

## Acceptance criteria

- [x] Default (1007 set): wheel and two-finger scroll still send arrows.
- [x] `CSI ? 1007 l`: wheel and two-finger scroll send nothing on the
      alternate screen.
- [x] Docs and CHANGELOG updated.

## Verification

- `node --test web/terminal-scroll.test.mjs`: new wheel and two-finger
  cases with `CSI ? 1007 l`; the existing default-on arrow cases still pass.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1144/1144.
- `npm run build:web`: succeeded.
- Not checked in a browser (pending, user): e.g. `printf '\e[?1049h\e[?1007l'; cat`,
  then scroll; nothing should be typed.

## Implementation notes

- `terminalAlternateScroll` in `web/terminal-input-bridge.mjs` (missing
  `getMode` counts as on), used by `onWheel` and `scrollByTouch`. With 1007
  off, the wheel event is still handled (returns true) so ghostty-web does not
  act on it.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
