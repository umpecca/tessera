# Task 286: Shift+Tab sends backtab without the Kitty keyboard protocol

Status: implemented, awaiting a check with a real keyboard (2026-11-24).

## Request

A bug report the user forwarded: "Tessera should send the proper Shift+Tab
code when no Kitty keyboard mode is active, either in the key handler in
web/terminal-view.mjs or in web/terminal-keyboard.mjs. That would fix
Shift+Tab for every program, including vim, fish and shell completion".

## Findings

- With no Kitty flags, keys Tessera does not handle itself fall through to
  ghostty-web's `InputHandler.handleKeyDown`, which answers Tab, Enter,
  Backspace, Escape, Home, End, Insert, Delete, Page Up/Down and F1-F12 from a
  table for "no modifiers or Shift only", so Shift is dropped: Shift+Tab sends
  `\t` instead of `CSI Z`. Arrows are not in the table and already get Shift
  (`CSI 1 ; 2 A`) from Ghostty's encoder.
- Ghostty's encoder with Kitty flags 0 gives xterm's sequences for Shift+Tab
  (`CSI Z`), Home/End (`CSI 1 ; 2 H/F`), Insert/Delete/Page Up/Down
  (`CSI n ; 2 ~`) and F1-F12 (`CSI 1 ; 2 P`..., `CSI n ; 2 ~`), but
  `CSI 27 ; 2 ; 13 ~` for Shift+Enter and `CSI 27 ; 2 ; 27 ~` for
  Shift+Escape, which shells do not understand; xterm sends plain `\r` and
  `ESC` for those.

## Scope

- `web/terminal-keyboard.mjs`: a pure function giving the sequence for
  Shift-only keys that ghostty-web gets wrong; used by the keydown handler in
  `web/terminal-view.mjs` before ghostty-web's fallback, only when no Kitty
  flags are set.
- Shift+Enter and Shift+Escape send Ghostty's `CSI 27 ; 2 ; 13 ~` and
  `CSI 27 ; 2 ; 27 ~` (from Ghostty's function-key table, sent whatever
  modifyOtherKeys is); Shift+Backspace stays DEL, as in Ghostty. First
  implemented as xterm's plain codes; changed after the user asked whether
  this matched Ghostty and chose to match it.
- Also Shift with Home, End, Insert, Delete, Page Up/Down and F1-F12
  (xterm's sequences); Shift+F3 is `CSI 13 ; 2 ~` as in Ghostty and kitty,
  since xterm's `CSI 1 ; 2 R` is the same bytes as a cursor position report.
- Approval: the user chose "Shift+Tab and the group" when asked whether to
  fix only Shift+Tab or the whole group.

## Acceptance criteria

- [x] Shift+Tab sends `CSI Z` with no Kitty flags; Tab still sends `\t`.
- [x] Kitty-protocol encoding unchanged.
- [x] Shift+Enter and Shift+Escape send Ghostty's codes; Shift+Backspace
      unchanged.
- [x] Shift with Home, End, Insert, Delete, Page Up/Down and F1-F12 sends
      Ghostty's (xterm's) sequences.
- [x] CHANGELOG entry.

## Verification

- `node --test web/terminal-keyboard.test.mjs`: new test for each key, the
  keys left alone (Enter, Backspace, Escape, arrows, letters, Clear), numpad,
  and Shift with Ctrl/Alt/Command.
- `node --test web/terminal-entry.test.mjs`: new test comparing every
  sequence (including Shift+Enter and Shift+Escape) with Ghostty's real
  encoder (Kitty flags 0); it caught Shift+F3.
- Compared with the pinned Ghostty source (`src/input/function_keys.zig`,
  `src/config/Config.zig`): same bytes as Ghostty on macOS for every key.
  Ghostty also extends a selection with Shift+arrows/Page/Home/End when one
  exists, and on Linux binds Shift+Home/End/Page Up/Page Down to scrolling and
  Shift+Insert to paste; Tessera does neither.
- `node --test web/*.test.mjs`: 1090/1090. `npm run build:web`: succeeded.
- Not checked with a real keyboard in a browser (pending, user): Shift+Tab in
  bash or zsh completion, fish, vim; Shift+Home in nano.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: Shift+Tab `CSI Z`, Shift+Enter `CSI 27;2;13~`, Shift+Escape `CSI 27;2;27~`, Shift+Home/End `CSI 1;2H/F`, PgUp/PgDn/Delete `CSI n;2~`, Shift+F1 `CSI 1;2P`, F3 `CSI 13;2~`, F5 `CSI 15;2~`, F12 `CSI 24;2~`. Shift+Insert sends nothing: it is the paste shortcut. zsh at its prompt prints the tail of the unbound `CSI 27;2;13~`, as expected. Synthetic key events; not tried on a physical keyboard.

## Implementation notes

- `terminalShiftedKeySequence` in `web/terminal-keyboard.mjs`, used after
  `terminalNavigationSequence` in the keydown handler in
  `web/terminal-view.mjs`, which runs only without Kitty flags. Apple
  relabelled arrows (Fn+arrow) and numpad keys keep their existing handling.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
