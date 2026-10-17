# Task 193: Quiet prediction marks and a solid cursor while typing

Status: complete

## Request

The underline on predicted text (task 189) was jarring, and the cursor
seemed to blink much faster while typing. Draw guesses plain unless they
could be wrong long enough to notice (option 3 of those offered), and fix
the cursor.

## Causes

- **Underline:** over a ~26 ms link a guess lives one or two frames before
  its echo replaces it, so every key flashed an underline on and off.
- **Cursor:** the blink timer ran regardless of typing, while the
  prediction overlay always drew its cursor solid. Each key during the
  blink's off half flashed the cursor on (prediction) and off again (echo).

## Changes

- `web/terminal-prediction.mjs`: guesses are drawn like real text and
  underlined only when marked, as mosh's "flagging": while the smoothed echo
  time is above 80 ms (plain again below 50 ms), or after a drawn guess was
  wrong or took over 250 ms, until 10 later echoes come back under 250 ms,
  counting at most one per 150 ms. Guesses that were never drawn (password
  prompts, Auto hidden over a fast link) do not mark later ones.
  `underlined()` reports the state.
- `web/terminal-cursor-blink.mjs`: `wake()` shows the cursor and starts the
  blink cycle over, redrawing only if it was hidden.
- `web/terminal-entry.js`: every key wakes the blink; the predicted cursor
  is hidden in the blink's off half and the overlay is redrawn on each blink,
  so only one cursor shows and both blink together. Diagnostics statistics
  include `underlined`.
- `web/app.js`: Diagnostics say `drawing underlined` when marked and give
  the rule; the Typing prediction setting's description is updated.
- `README.md`: Typing prediction describes the new marking.
- `web/vendor/terminal.js` rebuilt.

## Validation

- Engine tests: plain over a quick link, underlined over a slow one and
  plain again once the smoothed echo drops below 50 ms; a wrong guess marks
  until ten spaced quick echoes (fast typing alone does not clear it); a
  drawn guess confirmed after 300 ms marks; undrawn guesses mark nothing.
  Blink tests for `wake()`, and a terminal test that the predicted cursor
  hides with the real one and a key shows both at once. Full JavaScript
  suite: 638 pass.
- Real zsh through a local relay, headless Chrome, Auto, 48 keys at 140 ms
  intervals: at 35 ms echo, 47 guesses drawn and none underlined; at 125 ms,
  all 47 underlined; the cursor was visible right after every key in both.
