# Task 074: macOS Terminal control and Command keystrokes

Status: complete

Task 071 left `Cmd+V` into a TUI unverified on macOS. Checking it on a Mac found
`Cmd+V` working and two other keystrokes broken, both only on macOS — which is
why development on Windows never surfaced them.

`Ctrl+V` did nothing at all. `ghostty-web`'s `handleKeyDown` returns early for
`(ctrl||meta)+KeyV` without `preventDefault()` so the browser can deliver a
paste event. That is right where `Ctrl` is the paste accelerator. On an Apple
keyboard it is not, so `terminalPasteSource()` correctly declines the key, the
early return then swallows it, and no paste event is coming either: nothing
reaches the PTY and nothing pastes. A TUI editor that binds paste to `^V` — the
common case, including Fresh — cannot be pasted into with the key its own menu
advertises. Terminal.app sends `^V`.

`Cmd`+letter typed its bare character. Past the early return, `extractModifiers`
sets `SUPER` and the encoder is called with `utf8` set to the key's character;
it drops `SUPER` and returns that character. `Cmd+S` in a TUI editor inserted an
`s` into the document rather than doing nothing, which silently corrupts a
buffer. Terminal.app sends nothing to the PTY for `Cmd`+letter.

## Requirements

- Deliver `Ctrl+V` to the application as `^V` on an Apple keyboard.
- Leave `Ctrl+V` to the browser's paste event on platforms where it is the paste
  accelerator, so task 071's behaviour is unchanged there.
- Keep `Cmd+V`, `Cmd+C`, `Ctrl+Shift+V`, `Ctrl+Shift+C`, and `Shift+Insert`
  resolving as they already did.
- Consume `Cmd`+character keystrokes instead of letting the encoder turn them
  into terminal input.
- Leave `Cmd` with non-character keys, and every `Ctrl`/`Option` combination,
  encoded as before.

## Implementation

- `terminalControlSequence()` returns `\x16` for `Ctrl+V` when
  `appleKeyboard` is set, and null otherwise. The terminal key handler sends it
  and reports the key handled, which is what stops `ghostty-web`'s early return
  from swallowing it.
- `terminalShouldSwallowCommandKey()` matches a `Command`-only keystroke whose
  `key` is a single character — the only keys that reach the encoder's character
  fallback. The handler returns handled without sending anything.
- Both run after the copy and paste checks, so the combinations Tessera binds
  itself are resolved first and `Cmd+V` still returns `"native"`.

## Verification

- `node --test web/*.test.mjs` (103 tests passed)
- `node --check web/app.js`, `node --check web/terminal-keyboard.mjs`
- `go test ./...`
- Real-browser check on macOS (Chrome 150, Fresh 0.2.22 in a Terminal pane),
  driving genuine keystrokes and the real system clipboard over CDP and
  recording every frame sent to the terminal socket:
  - Before: `Ctrl+V` sent nothing and pasted nothing; `Cmd+S`/`Cmd+Z`/`Cmd+A`/
    `Cmd+F`/`Cmd+X` sent `"s"`/`"z"`/`"a"`/`"f"`/`"x"`.
  - After: `Ctrl+V` sends `\x16` and the clipboard text appears in the editor;
    those five `Cmd` keystrokes send nothing and the buffer is unchanged.
  - Unchanged: `Ctrl+C` `\x03`, `Ctrl+X` `\x18`, `Ctrl+Z` `\x1a`, `Ctrl+F`
    `\x06`, `Cmd+V` `ESC [ 200~ … ESC [ 201~`, plain keys, `Enter`, arrows.

## Not addressed

`Cmd+C` in a mouse-tracking TUI is still consumed by `isTerminalCopyShortcut()`
to copy `ghostty-web`'s local selection, which is empty there, so it copies
nothing and the application never sees the key. Letting it fall through when the
terminal has no local selection is a separate change.
