# Task 191: Predict cursor keys and mid-line edits

Status: complete

## Request

Extend typing prediction (task 189) to Left/Right and to editing in the
middle of a line, so fixing a typo in a long command is predicted too.
Before this, Left/Right ended the prediction run, and the next character
waited a full round trip; typing mid-line drew over the character under the
cursor until the echo shifted the line.

## Design

Predictions become edits replayed over the real line instead of a list of
cells:

- **char** inserts at the cursor and shifts the rest of the line right;
  **erase** (Backspace) removes the cell before the cursor and pulls the
  rest left; **move** (Left/Right, normal or application cursor mode) moves
  the cursor. Each records the cursor column before and after it.
- **Display:** the predicted line is the real row with the edits replayed.
  The overlay draws only cells that differ from the real row, underlining
  typed characters and drawing shifted text plain; draws the predicted
  cursor, with the character under a block cursor in reverse; and redraws
  the real cursor's cell without its cursor, so only one shows. Shifting
  stops at the first never-written cell, so a right prompt past the text is
  left alone.
- **Confirmation:** after output, the longest run of edits the screen shows
  is confirmed: the real cursor where the run leaves it and each predicted
  character in the cell the later edits move it to. A run that leaves the
  cursor where it started confirms without counting as an echo: no latency
  sample and no epoch confirmation, since the screen may not have changed.
  Deadline checks never confirm.
- **Contradiction** (withdrawn at once): the cursor leaves the row or every
  column the edits could leave it at, or it stands where only the server
  acting on an edit would put it but a predicted character is not there.
  A refused move or erase still waits for its deadline.
- **Limits:** Left and mid-line Backspace stay at or right of the leftmost
  column typed into on this row since Enter (tracked from confirmed
  characters), so the prompt is never guessed at. Right only moves over
  existing text. Mid-line inserts and erases need plain ASCII from the
  cursor to the end of the text, and inserts need room before the right
  edge. Enter, a wrong guess and external resets forget the typed-text
  boundary; other unpredictable keys (Up, Tab) keep it.

## Changes

- `web/terminal-prediction.mjs`: the edit model above.
- `web/terminal-prediction-overlay.mjs`: per-cell underline, a cover cell
  carrying its character, and the character under a block cursor.
- `web/terminal-entry.js`: deadline checks pass `output: false`.
- `web/vendor/terminal.js` rebuilt.

## Validation

- Engine tests: Left/Right within typed text (cursor on a character, real
  cursor hidden), Left stopping at the prompt and after Enter, Right
  stopping at the end of the text, mid-line insert (only the typed
  character underlined) confirmed by the shell's redraw, a typo fixed
  mid-line confirmed from one output chunk, no mid-line edits over wide
  text or at the right edge, an unexpected cursor jump withdrawn at once,
  deadline checks not confirming, a run back to its starting column not
  confirming the epoch. Existing tests updated for the new cell fields and
  the Backspace rule. Full JavaScript suite: 632 pass.
- Real zsh behind a local relay adding 60 ms each way, driven by headless
  Chrome: `echo hxllo`, then Left×3, Backspace, `e` showed `echo hello` with
  the cursor on the `l` before any echo, then confirmed with nothing left
  drawn; Right×3 and ` world` predicted and confirmed; Left×6 and Backspace
  mid-line predicted `hell world` and confirmed; Left on a fresh prompt and
  typing at `read -s` drew nothing.

## Known limits

- Shifted text is drawn in the default colors until the echo arrives.
- A shell plugin that redraws text right of the cursor on every key (such
  as zsh-autosuggestions) can keep mid-line edits from confirming; they are
  then withdrawn at their deadline.
- Home/End, Ctrl+A/E/W/U, Delete and Up/Down are not predicted.
