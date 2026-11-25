# Task 284: Honour mode 1007 (alternate scroll)

Status: complete (2026-11-25); the follow-up was checked live, physical-device touch not tried.

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
- Follow-up (2026-11-25), found in the live check: the scroll-made arrows
  ignore application cursor keys (DECCKM, `CSI ? 1 h`) and always send
  `CSI A`/`CSI B`; real arrow keys and Ghostty (`Surface.zig`) send
  `ESC O A`/`ESC O B` then. Send the format the mode asks for, wheel and
  touch. Approval: the user said "yes" to this fix.

## Acceptance criteria

- [x] Default (1007 set): wheel and two-finger scroll still send arrows.
- [x] `CSI ? 1007 l`: wheel and two-finger scroll send nothing on the
      alternate screen.
- [x] Docs and CHANGELOG updated.
- [x] With application cursor keys on, wheel and two-finger scroll send
      `ESC O A`/`ESC O B`; off, `CSI A`/`CSI B` as before.

## Verification

- `node --test web/terminal-scroll.test.mjs`: new wheel and two-finger
  cases with `CSI ? 1007 l`; the existing default-on arrow cases still pass.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1144/1144.
- `npm run build:web`: succeeded.
- Not checked in a browser (pending, user): e.g. `printf '\e[?1049h\e[?1007l'; cat`,
  then scroll; nothing should be typed.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: on the alternate screen the wheel sent `CSI A`/`CSI B`, nothing with `?1007l`. Found: with DECCKM on it still sends `CSI B`; Ghostty (Surface.zig) sends `ESC O B`. This predates task 284 (web/terminal-input-bridge.mjs hard-codes `\x1B[A`/`\x1B[B` for wheel and touch); not fixed, pending the user's decision.
- Follow-up (2026-11-25): `node --test web/terminal-scroll.test.mjs`: 24/24;
  the two new cases (wheel and two fingers under DECCKM) fail on the previous
  `web/terminal-input-bridge.mjs` and pass with the fix.
  `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1178/1178.
  `npm run build:web`: succeeded. `go test ./web/`: pass. Live, same test
  instance after a reload: with `CSI ? 1049 h CSI ? 1 h` the wheel sent
  `ESC O B`/`ESC O A`; without `CSI ? 1 h`, `CSI B`/`CSI A`. Two-finger touch
  covered by the unit test only.

## Implementation notes

- Follow-up: `terminalAlternateScrollKey(term, up)` in
  `web/terminal-input-bridge.mjs` reads mode 1 and returns SS3 or CSI arrows;
  `onWheel` and `scrollByTouch` use it. No core change.

- `terminalAlternateScroll` in `web/terminal-input-bridge.mjs` (missing
  `getMode` counts as on), used by `onWheel` and `scrollByTouch`. With 1007
  off, the wheel event is still handled (returns true) so ghostty-web does not
  act on it.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
