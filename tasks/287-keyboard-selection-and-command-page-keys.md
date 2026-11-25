# Task 287: Keyboard selection, clear selection on typing, Command+Up/Down as Page Up/Down

Status: implemented, awaiting a check in a browser (2026-11-24).

## Request

After task 286 the user asked whether Tessera should extend a selection with
Shift+arrows, Page Up/Down, Home and End as Ghostty does, and then: "write it
up and build it. make the clear on typing on by default and put as a
setting. could we also make command-left be home, command-right be end,
command-up be page up. and command-down be page down?"

## Findings

- Ghostty (pinned source, `src/config/Config.zig`, `src/terminal/Selection.zig`)
  binds Shift+arrows, Page Up/Down, Home and End to `adjust_selection`, only
  when a selection exists ("performable"); otherwise the key goes to the
  program. It moves the selection's end: Left/Right to the previous/next
  cell with text (wrapping rows), Up one row (or start of line at the top),
  Down to the next row with text (or end of line at the bottom), Page Up/Down
  one screen (or Home/End at the ends), Home to the first cell of the
  scrollback, End to the last column of the last row with text. It scrolls
  the end into view. `selection-clear-on-typing` (default true) clears the
  selection when a key is sent to the program.
- Tessera never clears a selection when typing, so without that a forgotten
  selection would keep taking Shift+arrows from the program.
- Command+Left/Right already send Home/End on Apple keyboards
  (`terminalCommandArrowSequence`, and the Kitty path). Command+Up/Down jump
  between shell prompts (`terminalPromptJumpDirection`), as in Terminal.app
  and Ghostty.

## Scope

- Selection: Shift alone with ←/→/↑/↓, Page Up/Down, Home or End, while the
  pane has a selection, moves its end as Ghostty does and scrolls it into
  view; otherwise the key goes to the program as now. Works with and without
  the Kitty protocol, as Ghostty's bindings come before encoding.
- Clear on typing: a key sent to the program from the keyboard clears the
  selection. Modifier keys alone, Tessera's shortcuts (copy, paste, prompt
  jumps), swallowed Command keys and selection keys do not. A browser
  setting, **Clear selection when typing**, in Settings → Terminal, on by
  default.
- Command+Up/Down on Apple keyboards: Page Up/Page Down to full-screen
  programs (alternate screen), prompt jumps at the shell (normal screen), in
  both ordinary and Kitty encoding. Command+Left/Right already Home/End
  (unchanged).
- Approval: the user asked for keyboard selection with clear-on-typing as a
  default-on setting, and Command-arrow keys; for Command+Up/Down they chose
  "PageUp/Down in full-screen apps", keeping prompt jumps at the shell.

## Acceptance criteria

- [x] With a selection, each Shift key moves the end as described and the
      view follows; the key does not reach the program.
- [x] Without a selection (or a single-cell click), the keys behave as before.
- [x] Typing clears the selection when the setting is on (default), not when
      off; modifiers, copy and paste do not clear it.
- [x] Setting saved in the browser; shown in Settings → Terminal.
- [x] Command+Up/Down send Page Up/Page Down on the alternate screen and jump
      prompts on the normal screen; Kitty encoding too.
- [x] Docs and CHANGELOG updated.

## Verification

- `node --test web/terminal-selection-keys.test.mjs` (new): key mapping and
  modifiers; left/right skipping blanks and rows; up/down with blank rows and
  both ends; Page Up/Down, Home, End over scrollback; scrolling the end into
  view both ways; no selection and single-cell clicks; clear-on-typing with
  the setting on and off, modifiers and keyup. 7/7.
- `node --test web/terminal-keyboard.test.mjs web/terminal-kitty-keyboard.test.mjs`:
  new Command+Up/Down cases (alternate screen, shell, Shift, non-Apple, Kitty).
- `node --test web/settings-modal.test.mjs`: the toggle is in Settings → Terminal.
- `node --test web/*.test.mjs`: 1099/1099. `npm run build:web`: succeeded.
- `go test ./...`: not run with this task; run in task 288, it caught the
  missing embed (see notes), now fixed.
- Not tested: the wiring in the keydown handler of `web/terminal-view.mjs`
  (no harness for it), and the whole feature in a browser (pending, user).
  Checked by reading ghostty-web that the renderer redraws the current
  selection's rows plus rows marked dirty, so marking the old rows before
  moving the end is enough, as pointer drags do.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: a drag selection extended by Shift+Right x4 and Shift+Down, Shift+End to the end of the screen; typing `x` cleared it and typed `x`. Cmd+Left/Right `CSI H`/`CSI F`; Cmd+Up/Down `CSI 5~`/`CSI 6~` on the alternate screen, nothing sent on the primary screen.

## Implementation notes

- `web/terminal-selection-keys.mjs` (new): `terminalSelectionAdjustment`,
  `adjustTerminalSelection` (Ghostty's `Selection.adjust` rules on
  ghostty-web's `selectionEnd`, absolute rows), `clearTerminalSelectionForTyping`.
- `web/terminal-view.mjs`: selection keys right after the copy shortcut,
  before prompt jumps, paste and any encoding; `typed()` before each path that
  sends a key (Kitty, control sequences, Command arrows, navigation/Shift
  sequences and ghostty-web's fallback). Native paste, Tessera shortcuts and
  swallowed Command keys don't clear.
- A selection whose end is moved back onto its start stops being a
  selection, as for a single click (ghostty-web's `hasSelection`); Ghostty
  keeps a one-cell selection.
- Command+Up/Down: `terminalCommandArrowSequence` and
  `terminalPromptJumpDirection` take `alternateScreen`; Kitty path in
  `terminalKittyKeyEvent`.
- Setting: `clearSelectionOnTyping` in `web/preferences.mjs`
  (`tessera.clear-selection-on-typing.v1`, default on), toggle in
  `web/settings-dialog.mjs`, wired in `web/settings-view.mjs`.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
- Fix found during task 288: `web/terminal-selection-keys.mjs` was missing
  from the `//go:embed` list in `web/embed.go`, so a built binary could not
  serve it (`go test ./web/` `TestAppModuleImportsAreEmbedded` failed; the
  1099 node tests did not catch it). Added; `go test ./...` passes.
