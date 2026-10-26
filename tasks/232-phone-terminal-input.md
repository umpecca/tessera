# Task 232: Phone terminal input

Status: complete (iPhone check pending)

## Request

Make typing into a terminal from a phone practical: running commands,
answering prompts, and writing new Claude Code prompts. Builds on the phone
view of task 231.

## Findings

- Terminal input goes through the container ghostty-web makes editable,
  with writing assistance off (task 151): right for keystrokes, but a phone
  then has no dictation, no correction and no way to edit a line first.
- `term.paste` brackets text when the program enabled bracketed paste, so a
  multi-line prompt reaches Claude Code as one message and a shell as an
  editable buffer.
- ghostty-web's keydown handler reads `code`, `key` and modifiers and does
  not check `isTrusted`; Tessera's own handler (Kitty protocol, Apple
  control keys, application cursor mode) runs inside it. A synthetic
  `KeyboardEvent` on the terminal container is therefore encoded exactly as
  a keyboard's. The document's window-shortcut handler sees it first in the
  capture phase, so Ctrl then `l` would have opened the window list.
- Shell integration reports the first line of a command, at most 200
  characters, for notices, with nothing to say it was shortened; the core
  also cuts at 512 bytes. A recent-command list built from that would offer
  `echo first-line` for a two-line paste and run only part of it. Found by
  the browser check below.
- User settings are columns that a page predating a new one overwrites;
  launcher shortcuts (task 174) have their own revisioned row instead.
- A phone keyboard covers the bottom of the page without shrinking the
  layout viewport; `visualViewport` gives its height.

## Changes

- `web/phone-input.mjs`: `PhoneInput`, shown under the open terminal by
  `PhoneView`: compose field (Send = text then Enter, hold = no Enter, empty
  Send = Enter, drafts per terminal in browser storage), key row (Type for
  direct typing, 123 for replies, Esc, Tab, Shift+Tab, sticky Ctrl, arrows,
  `^C`, `^D`, `|`, `~`, `/`, `-`, Enter), quick replies (`1` `2` `3` `y` `n`
  Enter Esc) shown while `terminalAwaitsReply`: an alert was waiting when
  opened, or a running command has been quiet 3 s; a sheet of snippets
  (add, edit, delete; a refused save reloads and keeps the edit) and recent
  commands, which fill the field. Buttons keep the field's focus so the
  keyboard stays up. Ctrl with a typed character sends that control key.
- `web/phone-view.mjs`: creates the input, attaches it on open with whether
  an alert was waiting, feeds it each summary, ticks every 2 s while a
  terminal is open, and sets `--phone-keyboard-inset` and
  `--phone-input-height` from `visualViewport` and the input's size.
- `web/app.js`: `sendPhoneText` (paste, then Enter 40 ms later as a key),
  `sendPhoneKey` (keydown and keyup on the container, recorded in
  `phoneKeyEvents` so `handlePaneKeyboardShortcuts` passes them), snippet
  load/save, storage; opening a terminal no longer focuses it.
- `web/styles.css`: input bar above the keyboard, terminal above the bar,
  key row scrolling sideways, sheet and snippet form; 16 px fields so iOS
  doesn't zoom.
- `internal/terminal/commands.go`, `summary.go`: up to 20 recent command
  lines per shell, newest first, each once, leaving out lines over 508
  bytes or ending in …; `recentCommands` in summaries.
- `internal/shellintegration/scripts/{zsh,bash}`: a shortened command line
  ends with …, which notices also show.
- `migrations/052_user_snippets.sql`, `internal/store/snippets.go`,
  `internal/httpapi/snippets.go` (routed in `sessions.go`): `GET`/`PUT
  /api/users/{user}/snippets`, compare-and-replace on a revision (409),
  at most 200 snippets of 16 KiB, names of 80 characters, unknown fields
  refused.
- `web/embed.go`, `README.md`, `CHANGELOG.md`, `ARCHITECTURE.md`.

## Departures from the plan

- Recent commands come from the host's summary rather than the browser, so
  the phone has them without having watched the commands run.
- Snippets have their own table and revision instead of living in user
  settings, so an older page can't erase them.

## Validation

- `web/phone-input.test.mjs`: key events for each key, Ctrl on keys and
  typed characters, waiting detection, Send / hold / empty Send, drafts per
  terminal, Ctrl used once, replies on waiting, alert and request, Type,
  sheet filling from recent commands and snippets, adding, a conflicting
  save, an empty snippet.
- `internal/store/snippets_test.go`, `internal/httpapi/snippets_test.go`:
  persistence across reopen, isolation, stale save refused, validation,
  unknown fields and trailing JSON, unknown user, methods.
- `internal/terminal/summary_test.go` (`-race`): recent commands once each,
  newest first, bounded, without long or shortened lines.
  `shell_integration_unix_test.go`: real zsh reports a two-line command as
  `echo two \…` and a 250-character one cut with ….
- Full JavaScript suite: 787 pass. `go test ./...`, `go vet ./...`, `-race`
  on the changed packages, `bash -n`/`zsh -n` on the scripts and `git diff
  --check` pass.
- Real host, built binary, this account's zsh, headless Chrome at 390×844
  with touch: terminal ends where the bar begins; Send ran `echo
  composed-$((6*7))`; a two-line text ran both lines; `^C` ended `sleep 30`
  (status 130); Ctrl then `l` cleared the screen with no window list; ↑ ↑
  Enter re-ran history; `read -k 1` brought up quick replies within a few
  seconds and `y` answered it, after which they went away; Esc under the
  Kitty protocol arrived as `ESC [ 27 u`; a snippet saved from the field was
  stored on the account and ran from the sheet; recent commands left out the
  two-line command; a draft survived going back to the list; with a 300 px
  keyboard the bar sat on it and the terminal above. `phone-smoke` from task
  231 still passes.
- Not tried: an iPhone (dictation, the real keyboard, Safari's focus rules),
  bash 4.4+ (only bash 3.2 here, so the bash script was syntax-checked), and
  Claude Code's own permission prompt.

## Not done

- The phone still takes the shell's size while in use (task 233), so the
  keyboard coming up resizes the shell.
