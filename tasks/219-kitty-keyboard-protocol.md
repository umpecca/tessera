# Task 219: Kitty keyboard protocol

Status: complete (iPad check pending)

## Request

Implement the Kitty keyboard protocol, so programs can tell apart keys the
ordinary encoding merges (Shift+Enter, Tab and Ctrl+I, Esc and Alt), which
matters most on the iPad's Magic Keyboard.

## Findings

- The core already pushes, pops and sets the protocol's flags per screen,
  and snapshots carry them, but it ignored the query (`CSI ? u`), so programs
  assumed there was no support. Nothing could read the flags.
- ghostty-web's input handler creates Ghostty's key encoder (in the terminal
  core) but never sets its Kitty flags, encodes only key presses, and sends
  printable characters and common keys as plain bytes before the encoder
  sees them. It has no keyup handling.
- The core exports the encoder's full C API: action, key, modifiers,
  consumed modifiers, composing, text and unshifted codepoint.
- ghostty-web's key table lacks Ghostty's `FN` key, so its numbers for Fn
  Lock, Print Screen, Scroll Lock, Pause and the media keys are one lower
  than Ghostty's. Left as it is for ordinary encoding.
- Tessera's own key handling on top: copy, paste (including the paste bridge
  that keeps `Cmd+V` from ghostty-web), prompt jumps, Command never reaching
  the program, Command+Left/Right as Home/End, Globe+arrows, numpad keys with
  Num Lock off. Window shortcuts run in a document capture handler first.

## Changes

- `internal/terminalcore/source/report_api.zig`,
  `scripts/patch-terminal-core.mjs`: `CSI ? u` is answered with the active
  screen's flags; `tessera_kitty_keyboard_flags`.
  `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `4c64011f471fd04e1d03c2bf91c6e16a771fa54c66e75aa0e90ce197deb9cb15`; rebuilt
  again in task 220).
- `web/terminal-kitty-keyboard.mjs` (embedded): Ghostty's key numbers by
  `KeyboardEvent.code`, taken from Ghostty's header; `terminalKittyKeyEvent`
  turns a key event into the encoder's fields:
  - text: one printable character;
  - the unshifted key: the layout's character, else the US one, so Shift+1
    is `1`;
  - Shift counted as spent on the text it typed;
  - Option is Alt on an Apple keyboard, as in ordinary encoding;
  - Command is never sent on an Apple keyboard, except Command+Left/Right
    as Home/End;
  - Globe+arrows and Num Lock-off numpad keys as what they navigate to;
  - dead keys marked as composing.
- `web/terminal-entry.js`: `kittyKeyboardFlags()`, and `encodeKeyEvent()`,
  which runs the core's encoder with the flags and the cursor key, keypad
  and Alt-prefix modes.
- `web/app.js`: while the flags are non-zero, the terminal's key handler
  sends every key through the encoder, after Tessera's copy, paste and
  prompt-jump keys. A keyup listener reports releases for keys whose press
  was sent, when the program asked for them (flag 2), as the key the press
  was sent as. With the flags at zero nothing changes.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: the query before and after push,
  set with or, pop, the alternate screen's own flags, a snapshot, and a
  full reset.
- `web/terminal-kitty-keyboard.test.mjs`: key numbers (including past
  `FN`); text, unshifted keys and Shift; Option as Alt; Command, Home and End,
  Globe and numpad keys; releases, repeats, dead keys and keys without a
  code.
- `web/terminal-entry.test.mjs`, the real core's encoder: under flag 1,
  plain text, `ESC[27u` for Escape, `ESC[105;5u` for Ctrl+I, `ESC[13;2u` for
  Shift+Enter, Tab, Enter and Backspace unchanged; releases under flag 3;
  everything as escape codes under flag 8, with alternates (13) and text
  (25); back to ordinary encoding after the pop.
- Full JavaScript suite: 726 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome with key events from the DevTools protocol, a raw-mode
  program that pushed flags 3 and queried. It got:
  - `ESC[?3u` in reply to the query;
  - Escape: `ESC[27u`, then its release `ESC[27;1:3u`;
  - Shift+Enter: `ESC[13;2u`;
  - Ctrl+I: `ESC[105;5u` and its release;
  - `a`: `a`, then its release `ESC[97;1:3u`;
  - Command+Left: Home, `ESC[1;1:1H`, and its release;
  - Command+S: nothing;
  - Tab: a tab.

  No page errors.
- Not yet tried on the iPad, or with a real Kitty-aware program (Neovim,
  Helix and fish aren't installed here).
