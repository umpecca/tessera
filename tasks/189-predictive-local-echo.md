# Task 189: Predictive local echo

Status: complete

## Request

Typing over a high-latency link (Tailscale from another state, likely 30-80 ms
per round trip) waits for the server's echo before each character appears.
Show typed characters immediately, mosh-style, without ever changing what the
terminal really contains. Follow-up to task 188.

## Design

Client-only; no protocol or server change.

- **Engine** (`web/terminal-prediction.mjs`, no DOM): keeps an ordered list of
  predicted cells `{col, row, char, epoch, sentAt}` and a predicted cursor.
- **Input:** a single printable, single-width character (ASCII 0x20-0x7e) is
  predicted at the predicted cursor, which then advances. Anything else
  (Enter, Backspace, control characters, escape sequences such as arrows,
  multi-character input such as paste) clears all predictions and starts a new
  epoch. No prediction when the line would wrap, while scrolled into history,
  or while the terminal is not at its bottom.
- **Confirmation:** after every applied output event, each prediction is
  compared with the real cell at its position. A matching codepoint confirms
  it (removed, epoch marked confirmed, latency sampled). A prediction still
  unmatched after its judgement deadline (`max(250 ms, 3 × smoothed RTT)`, at
  most 2 s) is a mismatch: clear everything, start a new epoch.
- **Epochs (safety):** a prediction is displayed only if its epoch has had at
  least one confirmation. A new epoch is therefore invisible until the server
  proves it echoes in this context. At a password prompt the first character
  never echoes, so nothing is ever drawn.
- **Display policy:** setting **Typing prediction** with Auto (default),
  Always, Off, saved per browser. Auto displays predictions only while the
  smoothed confirmation latency exceeds 20 ms (hysteresis: on above 20 ms, off
  below 10 ms); predictions are still tracked invisibly to measure latency.
  Off disables tracking.
- **Reset events:** resize or geometry change, snapshot restore, switching
  to or from the alternate screen, scrolling away from the bottom, socket
  reconnect, pane hidden.
- **Overlay:** a transparent canvas over the terminal canvas, same size and
  device pixel ratio, `pointer-events: none`. It is redrawn after each
  terminal paint and whenever predictions change: each visible prediction
  fills its cell with the theme background, draws the character in the theme
  foreground with the renderer's font and baseline, and underlines it; a
  cursor is drawn at the predicted cursor position.

## Non-goals (v1)

Predicting Backspace, cursor movement or wide characters; using the PTY's
termios state on the server; insert-mode reflow of text right of the cursor
(the existing text shifts when the real echo arrives, as in mosh).

## Validation plan

- Engine unit tests: prediction placement and advance, confirmation, mismatch
  and expiry, epochs hiding unconfirmed contexts (password case), resets,
  wrap limit, latency smoothing and Auto hysteresis.
- Real server with an artificial delay to make predictions visible; headless
  Chrome screenshots of underlined predictions before the echo and of the
  clean state after it; a `read -s` password prompt shows nothing.
- Full Go and JavaScript suites.

## Implementation record (2026-10-16)

- `web/terminal-prediction.mjs`: the engine as designed. A prediction is
  confirmed only when its cell holds the character **and** the real cursor
  has moved past it, so text already under the cursor is not mistaken for an
  echo. Confirmed predictions are removed from the front of the queue only.
  Latency is smoothed with a 1/8 EWMA.
- `web/terminal-prediction-overlay.mjs`: a canvas absolutely positioned over
  the terminal canvas with the same bitmap size, CSS size and device pixel
  ratio. It copies the renderer's font, metrics, theme and cursor style.
- `web/terminal-entry.js` (bundled; `web/vendor/terminal.js` rebuilt, and the
  unchanged source was first confirmed to rebuild byte for byte):
  `predictInput`, checks after every write, a deadline timer, and resets on
  geometry, snapshot, `reset`, scrolling away from the bottom, and pausing.
  New predictions draw at once; removals redraw the overlay in the same paint
  as the terminal, so a confirmed character never blinks out. Prediction is
  refused while the real cursor is hidden or the screen switched since the
  run began.
- `web/app.js`: all keyboard input (data, control sequences, special keys,
  startup commands) goes through `sendTerminalKeys`, which tells the
  predictor first; socket closes reset it; **Typing prediction** setting.

Validation:

- Engine tests (8): hidden first epoch, ordered confirmation, password prompt
  never shown and withdrawn, wrong/late guess resets to hidden, pre-existing
  character not mistaken for echo, resets on unpredictable input, wrap,
  scrolled or switched screens, Auto hysteresis, Off.
- Terminal hook test: drawn immediately on input, erased in the paint that
  shows the echo, Enter starting a hidden run.
- Full JavaScript suite passes (561); Go suites pass.
- Real server behind a local relay adding 60 ms each way (about 120 ms round
  trip), headless Chrome typing at 25 ms per key: predicted characters
  appeared 122-157 ms before the server's echo (the first three after Enter
  28-92 ms, while their run awaited confirmation); the overlay was empty
  after the echoes; typing into `read -s` drew nothing and the shell received
  all six characters.

## Backspace prediction (2026-10-16)

- **Withdraw:** Backspace (DEL or Ctrl+H) when the newest prediction is a
  character drops it; the character and the Backspace reach the server
  together, so the line ends as if neither was typed.
- **Erase:** otherwise, if the row is blank from the predicted cursor to the
  end (cells with a pending erase count as blank), predict an erase of the
  cell before the cursor: drawn as an empty cell with the cursor on it. It is
  confirmed when the cell is blank and the real cursor is on or before it, or
  when a later prediction on the same cell is confirmed (the erase and the
  next character often arrive in one output chunk, so the blank is never
  seen). Mid-line or at column 0, Backspace resets to a hidden epoch.
- A refused erase (Backspace into a prompt) is withdrawn at its deadline, as
  any wrong guess is; in an unconfirmed epoch (password prompt) nothing draws.

Validation: 6 new engine tests (withdraw incl. Ctrl+H, erase and per-step
confirmation, erase plus next character in one chunk, mid-line and left edge,
refused erase withdrawn, password prompt), 567 JavaScript tests passing, and
the relay run in headless Chrome: a typo corrected while still predicted
(overlay `helo` → `hel` → `he` → new text, matching what the shell received),
two Backspaces over echoed `abc` blanking `bc` before the echo and `xy`
confirmed in their place (`axy`), and a mid-line Backspace after arrow keys
drawing nothing (`1245`).

## Review fixes (2026-10-16)

- **Double cursor after an erase.** The overlay drew the predicted cursor
  while the terminal still drew its real cursor at the old end of the line.
  The engine now tracks the real cursor cell and, when no prediction covers
  it and it is blank, reports it as `cover`; the overlay blanks it.
- **Wrong guesses lingered until their deadline.** `check` now withdraws the
  oldest unconfirmed prediction as soon as the screen contradicts it: the
  cursor left its row, or passed a character prediction's cell while that
  cell holds something else. Erases still wait, since a refused erase looks
  like a slow one.
- **Late echoes were cut off.** With contradictions caught immediately, the
  judgement deadline rose from `max(250 ms, 3 × RTT)` (cap 2 s) to
  `max(600 ms, 4 × RTT)` (cap 3 s), so a jitter spike no longer makes typed
  text vanish and reappear.
- **Diagnostics.** Settings → Diagnostics and copied diagnostics show each
  terminal's prediction mode, whether it is drawing, and the measured echo
  time, for checking Auto on the iPad.

Validation: engine tests now 17 (contradiction withdrawn at once, row change,
late echo waited for and confirming without reset, four-round-trip deadline
on slow links, cover after erases, diagnostics wording); 570 JavaScript tests
pass; relay run repeated: erase blanks the real cursor (7 overlay fills, was
5), fast typing still leads the echo by 122-148 ms with no false resets,
password prompt draws nothing.

Follow-ups: a slightly stronger underline if
it proves too faint on the iPad; server-side termios as an extra
password-prompt signal; verify in Safari on iPadOS over Tailscale.

## iPad check (2026-10-16)

Current build (15ac2a4) run as a separate test server on the Mac's Tailscale
address, opened in Safari 27.0.1 on the iPad over a direct Tailscale
connection (network round trip 26-27 ms, measured with
`scripts/latency-check`; see task 188).

- Settings → Diagnostics: **Auto, drawing**, measured echo **44 ms**. Auto
  turns on as intended at this round trip.
- `read -s` on the iPad: nothing drawn while typing, as intended.
- The echo time is about 17 ms longer than the network round trip; zsh has no
  per-keystroke plugins. That time is spent in the PTY, the shell, Tessera's
  server or the client applying output. Broken down in task 190: the 44 ms
  was the smoothed average (median 31 ms), and the real extra cost was the
  prediction check reading the whole viewport, now fixed.
- Note: the user's day-to-day server (`~/Desktop/tessera-darwin-arm64`) was
  built from f7145d5 and lacked the review fixes and the diagnostics line;
  it needs a rebuild to get them.
