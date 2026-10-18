# Task 195: Command+Left/Right as Home and End

Status: complete (iPad check pending)

## Request

The iPad Magic Keyboard has no Home or End. Map Cmd+Left/Right to them
without interfering with other workflows: Ctrl+Left/Right (word movement in
shells and editors) and Ctrl+Backspace (Destroy Window in Tessera) were
considered and left alone.

## Changes

- `web/terminal-keyboard.mjs`: `terminalCommandArrowSequence` turns
  Cmd+Left into Home and Cmd+Right into End on an Apple keyboard, with no
  other modifier held. It sends exactly what ghostty-web sends for the Home
  and End keys, `ESC [ H` and `ESC [ F` in every cursor mode, so Cmd+arrows
  work wherever Globe+Left/Right (Home and End on the iPad) do. An earlier
  version followed xterm and sent `ESC O H`/`ESC O F` in application cursor
  mode; that made the two differ, so it was dropped. Not ^A and ^E, which
  mean other things in vim and tmux. Command never reached the application
  before, so nothing is taken from it.
- `web/app.js`: the terminal key handler sends that sequence after the Ctrl+V
  case. Window shortcuts are unaffected: Cmd+Shift+Up/Down and
  Cmd+Backspace keep their meanings, and nothing used Cmd+Left/Right.
- Typing prediction is not extended. Home and End end the predicted run, as
  ^A does: predicting Home needs the start of the typed input, which is
  unknown after history recall, and End is wrong when zsh-autosuggestions
  draws text after the cursor.
- `README.md`, `CHANGELOG.md`: the mapping and the zsh bindings.

## Validation

- `web/terminal-keyboard.test.mjs`: both sequences; no
  sequence without Command, with Shift, Ctrl or Option added, for other keys,
  or off an Apple keyboard. Full JavaScript suite and Go suite pass.
- Real host and PTY, headless Chrome on the Mac, keys sent over the DevTools
  protocol into a terminal window:
  - `cat -v` received `^[[H^[[F`, also after `printf '\e[?1h'`, the same
    as for the Home and End keys themselves.
  - `bash --norc --noprofile`: `cho hi > file`, Cmd+Left, `e`, Cmd+Right,
    ` there`, Enter wrote `hi there`.
  - The login zsh (the user's own config) ignored both: Home and End are
    unbound there, so the `e` was appended. After
    `bindkey '^[[H' beginning-of-line '^[[F' end-of-line` the same keys
    wrote `hi there`. The README gives that line.
- On the iPad, Globe+Left/Right already act as Home and End (reported by
  the user), so Globe needs no mapping. Cmd+Left/Right not yet tried there;
  task 194's key readout shows whether Safari delivers them.

## Not done

Forward Delete. Globe+Backspace is the candidate, with Shift+Backspace as
the fallback (Cmd+ and Ctrl+Backspace are Destroy Window); the task 194
readout on the iPad will show whether Safari reports Globe+Backspace.
