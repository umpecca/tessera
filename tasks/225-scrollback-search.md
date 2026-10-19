# Task 225: Find in a terminal's scrollback

Status: complete (iPad check pending)

## Request

Search a terminal's scrollback (Cmd+F), the gap left after the terminal
features from the earlier lists.

## Findings

- Tessera had no find. Ghostty's core has a searcher (`search/screen.zig`):
  ASCII case-insensitive, matches that wrap across rows, incremental, with
  results tracked by pins so they survive output, history trimming and
  screen switches, and a selection that stays on its match. The WASM build
  didn't include it.
- Compiling it for wasm32 fails in Ghostty's formatter, which the searcher
  uses to read page text: a `u64` byte count used as a `usize`.
- The search holds tracked pins on its screen. A full reset frees the
  alternate screen; freeing the terminal deinitialises the handler before
  the screens. A snapshot import is a new terminal.
- The browser's core has the history the user scrolls through; the host's
  core needn't search.
- ghostty-web draws each row's backgrounds then text per cell, which a
  renderer patch can highlight; but Tessera's plain renderer, on by default,
  draws plain ASCII cells itself and passes rows with a selection or hovered
  link to the per-cell path. The first live run showed no highlights for
  that reason.
- `Ctrl+F` is the shell's (forward a character); Tessera's window keys use
  Ctrl or Command, and Command+F is free on an Apple keyboard.

## Changes

- `internal/terminalcore/source/search_api.zig`,
  `scripts/patch-terminal-core.mjs`: one search per terminal in the stream
  handler; `tessera_search_start`, `_update`, `_select`, `_selected`,
  `_matches` (rows from the top of the history, newest first) and `_end`.
  A full reset and the handler's deinit end it. The formatter's
  `discarding.count` is cast to `usize`. `internal/terminalcore/ghostty-vt.wasm`
  rebuilt (core `b90b92d3fedd5e75bd45b80867db552177363d187f94574f4d105b723ad4c627`;
  rebuilt again in task 227);
  `web/vendor/terminal.js` rebuilt with it.
- `web/terminal-entry.js`: `search(needle)`, `searchSelect(older)`,
  `onSearchChange`, output searched 150 ms after it stops,
  `restartSearch()` after a snapshot or reset, the selected match scrolled a
  third of the way down when it isn't showing, and the matches showing by
  viewport row for the renderer (at most 10,000 read; the count is all).
- `web/terminal-search-highlight.mjs` (bundled): match cells drawn on
  yellow, the selected one on orange, with dark text; a text selection wins.
  `web/terminal-plain-renderer.mjs`: rows with matches go to the per-cell
  path.
- `web/terminal-find.mjs` (embedded): the find bar (search as you type,
  80 ms pause; Enter and Shift+Enter; Escape; the count from the oldest;
  buttons that keep the keyboard in the field; 16 px text so iPadOS doesn't
  zoom) and the keys: Command+F, Command+G, Command+Shift+G on an Apple
  keyboard; Ctrl+Shift+F, F3 and Shift+F3 elsewhere.
- `web/app.js`: the keys in the window shortcut resolver (terminal
  windows only; dialogs block them), **Find…** in the terminal menu, **Find
  in Terminal** in the palette, the help list; a one-line selection is the
  text to find; the bar goes with its terminal. `web/embed.go`.
  `web/styles.css`: the bar.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`; a note in task 223.

## Validation

- `internal/terminalcore/core.test.mjs`: matches newest first ignoring
  case, one wrapping across rows, selection older and newer without
  wrapping, capacity, new output searched with the selection kept, empty,
  missing and oversized needles, ending; following a program onto the
  alternate screen and back, a full reset ending it and a new one after;
  history trimmed under it, and a resize.
- `web/terminal-entry.test.mjs`, with the real core: matches, rows,
  scrolling to an older match, highlights by viewport row, one update for a
  burst of output keeping the selection, ending, starting again on a new
  core.
- `web/terminal-find.test.mjs`: the keys; the count; the bar searching
  after a pause, Enter running a held search and moving, Shift+Enter,
  "No matches", Escape ending the search, a selection searched at once,
  reopening; highlight lookup (including a wide character) and drawing,
  with a text selection winning. `web/terminal-plain-renderer.test.mjs`:
  rows with matches take the per-cell path. `web/pane-interaction.test.mjs`:
  the keys open and move find in a terminal window only, not over dialogs
  or for a browser window, and Ctrl+F stays the shell's.
- Full JavaScript suite: 749 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome, real key events, 132 lines of output: Command+F opened
  the bar with the keyboard in it; "error" found 2 (both cases) on the last
  rows, highlighted; "module_1" found 32, and 30 Enters scrolled back
  through history to them, the selected one orange; Shift+Enter and
  Command+G moved; new output raised the count to 34 with the selection on
  the same match; Escape closed the bar, ended the search and put the
  keyboard back in the terminal. No page errors.
- Not yet tried on the iPad: whether Safari lets the page have Command+F.
