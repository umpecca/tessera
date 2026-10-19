# Task 211: Prompt jumps and command output (OSC 133)

Status: complete (iPad check pending)

## Request

Implement OSC 133. Of the features it allows, jump between prompts and copy
a command's output (not exit status marks or completion notices).

## Findings

- The core parsed OSC 133 and marked the cursor's row (prompt, continuation,
  input, first output row); later output rows carry no mark. Nothing could
  read the marks, and the exit code from 133;D is dropped.
- 133;B turned a prompt row into an input row. On a one-line prompt that
  erased where the prompt began, so after a command with no output (`cd`,
  `false`) two prompts sat on consecutive rows marked alike and counted as
  one. The mark from 133;C on that row is overwritten by D and A as well.
- When zsh redraws a command line that has wrapped (after a resize), it can
  mark the wrapped half as a new prompt. ghostty-web reports soft wraps only
  for the screen, not scrollback.
- ghostty-web's `selectLines` counts rows from the view rather than the
  buffer, and it clears the selection on any click outside the terminal,
  including the menu click that asked for it.
- Ctrl/Cmd+Shift+Up/Down already move windows.
- zsh sends no OSC 133 by default.

## Changes

- `internal/terminalcore/source/semantic_api.zig`,
  `scripts/patch-terminal-core.mjs`: `tessera_semantic_rows(handle, row,
  count, out)` copies each row's mark, plus 8 for a soft-wrapped row, rows
  counted from the oldest scrollback line. 133;B leaves a row already marked
  as a prompt. `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `4d54e9d52aeaf4c94e6c3611403ed9142bf35f989e6761b42b6c22b4566e122a`; rebuilt again in task 212).
- `web/terminal-prompts.mjs`: `promptStarts` (a prompt mark, or the first of
  a run of input rows for shells that send only B; never the wrapped half of
  a prompt line), `adjacentPrompt`, `commandOutput` (from the first output
  row to the row before the next prompt, without trailing blank rows),
  `lastCommandOutput`.
- `web/terminal-entry.js`: `semanticMarks()`, `scrollToPrompt(direction)`
  (smooth scroll, counting from where a scroll in progress is heading),
  `commandOutputAt(row)`, `selectCommandOutput(row)`, `selectRows(start, end)`
  (sets ghostty-web's selection in buffer rows).
- `web/terminal-keyboard.mjs`: `terminalPromptJumpDirection`: Cmd+Up/Down on
  an Apple keyboard, Ctrl+Shift+Page Up/Down anywhere.
- `web/app.js`: the jump keys in the terminal's key handler; **Copy Command
  Output** in the terminal menu, for the command at or above the row under
  the pointer, disabled when it has none; **Copy Last Command Output** in the
  palette. Copying selects the output, copies at once (Safari needs the
  click), and selects it again after ghostty-web's outside-click clear. A
  status explains shell integration when there is nothing to copy.
- `~/.zshrc`: precmd/preexec hooks sending D (with exit status) and C, and A
  and B wrapped around PS1.
- `web/vendor/terminal.js` rebuilt. `README.md` (with the hooks),
  `CHANGELOG.md`, `docs/terminal-core.md`.

Copying uses ghostty-web's selection text, so, as with a mouse selection, a
soft-wrapped output line is copied as two lines.

## Validation

- `internal/terminalcore/core.test.mjs`: marks for prompts, output, a command
  with no output, B without a prompt mark, a soft-wrapped row; through
  scrollback, past the end, a snapshot, and the alternate screen (none).
- `web/terminal-prompts.test.mjs`: prompt starts (multi-line prompts, input-
  only shells, redraw onto a wrapped row), previous/next, output ranges
  (blank trailing rows, no output, running command, wrapped rows), last
  output.
- `web/terminal-entry.test.mjs`, real core: jumps up to the first prompt and
  back to the bottom, and output selection by row and last.
- `web/terminal-keyboard.test.mjs`: the jump keys, and that Cmd+Shift+Up stays
  window movement.
- Full JavaScript suite: 695 pass. `go test ./...` fails only on the
  unembedded `screensaver.mjs`, as before. `npm run verify:terminal-core`
  reproduces the core.
- The zsh hooks send A, B, C, D;0 for `echo hi`, D;1 for `false`, and only A
  and B for an empty Enter.
- Real host, the real zsh with the hooks, headless Chrome over the DevTools
  protocol: after a startup command and `seq 1 15`, `echo one`,
  `seq 100 120`, `false`, `echo last`, Cmd+Up stopped at each earlier prompt
  in turn and stayed at the first; Cmd+Down went forward; **Copy Command
  Output** over the `seq 1 15` output copied `1`…`15` and left it selected;
  the palette command copied `last`. Before the 133;B change, `false` and
  `echo last` were one stop; before the wrap flag, the startup command's
  wrapped half was a stop.
- Not yet tried on the iPad.
