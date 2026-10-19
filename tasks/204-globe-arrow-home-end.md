# Task 204: Globe+Left/Right as Home and End

Status: complete (iPad check pending)

## Request

Globe+Left in zsh did not go to the start of the line; it typed `9D` or
similar.

## Cause

ghostty-web encodes `KeyboardEvent.code`, the physical key, together with
every modifier flag. The trailing `9D` is the tail of `ESC [ 1 ; 9 D`:
modifier 9 is 1 + 8 (Command), on the left arrow. So WebKit delivered
Globe+Left with `code: "ArrowLeft"` and `metaKey: true`, and a `key` other
than `ArrowLeft` (otherwise task 195's Cmd+Left mapping would have sent
Home) — the logical `Home`. Neither Tessera handler matched it:
`terminalCommandArrowSequence` needs `key: "ArrowLeft"`, and
`terminalNavigationSequence` only translates numpad codes. Task 195 took
Globe+Left as already working from an earlier report; the key readout from
task 194 was never recorded on the iPad.

## Changes

- `web/terminal-keyboard.mjs`: `terminalNavigationSequence`, which already
  encoded numpad keys by their logical key, now also takes `appleKeyboard`
  and does the same for a physical arrow reporting a navigation key (Home,
  End, PageUp, PageDown: Globe+Left/Right/Up/Down). One function covers both
  cases where the physical and logical keys differ. On an Apple keyboard
  Command is dropped from the modifier: it never reaches the application,
  and the Home key itself sends the plain `ESC [ H`. That also changes
  Cmd+numpad keys, which sent `ESC [ 1 ; 9 H` and the like and now send what
  the key sends without Command. Shift, Option and Ctrl still add xterm
  modifier parameters. Off Apple keyboards nothing changes.
- `web/app.js`: passes `appleKeyboard` to it.
- `CHANGELOG.md`. The README already describes Globe+Left/Right as Home/End.

Ctrl+Left/Right were reported doing the same thing (`5D`). That is not a
Tessera fault: they send the standard xterm `ESC [ 1 ; 5 D`/`C`, which the
user's zsh left unbound, as it did Home and End. Fixed in `~/.zshrc` with
`bindkey '^[[1;5D' backward-word '^[[1;5C' forward-word` alongside the
README's Home/End line.

## Validation

- `web/terminal-keyboard.test.mjs`: the four Globe+arrow keys with and
  without Command, Shift and Ctrl variants; no sequence for real arrows, the
  real Home key or Globe+arrow off an Apple keyboard; Command left out of
  numpad keys on an Apple keyboard, also in application keypad mode. Full JavaScript
  suite passes. `go test ./web/...` fails on `TestAppModuleImportsAreEmbedded`
  (`screensaver.mjs` is not embedded), the same before this change.
- Not yet run on the iPad. Settings → Diagnostics key readout for
  Globe+Left should show `key Home`, `code ArrowLeft`; `cat -v` should then
  receive `^[[H`.

## Not done

Globe+Backspace as forward Delete: if it reports `key: "Delete"` on
`code: "Backspace"`, it has the same shape and needs the same treatment, but
that is a different physical key and unconfirmed.
