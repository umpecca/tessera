# Task 296: Setting to turn off the blinking cursor

Status: complete (2026-11-25).

## Request

The user asked whether the blinking cursor can be turned off. Only the Older
Mac performance profile did it (with a 30 FPS cap, 1x pixel ratio and no
smooth scrolling), or a program's `CSI 2 SP q`. The user said "yes add the
setting".

## Scope

- Settings → Terminal: a "Blinking cursor" switch, on by default, saved in
  this browser like "Clear selection when typing", applied at once to open
  terminals and to new ones (Ghostty's `cursor-style-blink`).
- Blinking happens only while the switch is on and Older Mac mode is off.
  Programs still choose the cursor's shape; a program can stop the blink but
  not start it while blinking is off, as with Older Mac mode today.
- Blinking text (`ESC [ 5 m`) follows the same switch, as it already follows
  the pane's blink.
- Approval: the user said "yes add the setting" to this proposal.

## Acceptance criteria

- [x] Turning the switch off stops the cursor blinking in open terminals at
      once, and new terminals start steady; on again resumes blinking.
- [x] Older Mac mode still turns blinking off whatever the switch says;
      leaving it restores the switch's choice.
- [x] The choice survives a reload (browser storage), default on.
- [x] Docs and CHANGELOG updated.

## Verification

- `node --test web/performance-profile.test.mjs web/settings-modal.test.mjs`:
  new tests: default on, saved as `tessera.cursor-blink.v1`, open terminals
  told at once, Older Mac mode forces steady and leaving it restores the
  setting, a stored "false" loads off; the Terminal page lists "Blinking
  cursor" with its state and its change calls the setter.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1180/1180.
  `go test ./web/`: pass. `npm run build:web`: succeeded.
- Live (headless Chromium via Playwright, test instance 127.0.0.1:7400,
  `-web web/`), the real Settings window: cursor frames over 1.2 s 2 (blinking)
  -> Off -> 1; after a reload still 1 and storage "false" (new terminal views
  start steady); `printf '\e[1 q'` (program asks to blink) stays 1 while off;
  On -> 2.

## Implementation notes

- `web/preferences.mjs`: `cursorBlink` / `cursorBlinkStorageKey` loaded with the
  other browser settings, `setCursorBlink`, `terminalCursorBlinks()` (setting
  and not Older Mac), used by `setOlderMacMode` and new terminals
  (`web/terminal-view.mjs`). The pane's existing blink switch
  (`setCursorBlinkEnabled`) also drives blinking text.
- `web/settings-dialog.mjs` row, `web/settings-view.mjs` state/action;
  `web/application.test-support.mjs` fixture owners.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
