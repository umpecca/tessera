# Task 212: Palette and dynamic colours (OSC 4/104, 10–19/110–119)

Status: complete (iPad check pending)

## Request

Implement OSC 4/104 (set, query and reset the 256-colour palette, as
base16-shell does) and OSC 10–19/110–119 (set and reset foreground,
background and cursor colours, and selection colours on 17 and 19), with
their queries.

## Findings

- Ghostty's core parses all of them, including several requests in one
  sequence (`11;a;b` sets 11 then 12) and the terminator, but the WASM
  handler's `colorOperation` was an empty stub: no colour changed and no
  query was answered.
- The terminal already keeps dynamic colour state: a palette with a mask of
  changed entries and default/override pairs for foreground, background and
  cursor, all in snapshots. The core resolves every cell's colours from it,
  so palette and default-colour changes reach text and cell backgrounds once
  rows redraw.
- The renderer takes the canvas and padding background, cursor and
  selection colours from the pane's theme object, not the core.
- Tessera's light/dark setting changes the defaults (`tessera_sixel_configure`)
  and leaves overrides alone. Ghostty's `DynamicRGB.reset()` pins the
  override to the current default, which a later mode change would not move.
- A full reset left colours unchanged.
- Queries are answered by the server's core, whose replies go to the PTY;
  the browser's are discarded.

## Changes

- `internal/terminalcore/source/color_api.zig`,
  `scripts/patch-terminal-core.mjs`: `colorOperation` sets, resets and
  queries palette entries (4, 104 with and without indexes) and foreground,
  background, cursor (10–12, 110–112) on the terminal, and selection
  background and foreground (17, 19, 117, 119) on the handler. Resets clear
  the override, so the pane's mode applies. Queries answer in 16-bit `rgb:`
  form with the request's terminator; unset selection colours report the
  foreground and background, which is how Tessera selects. 13–16 and 18 are
  ignored. Each change marks the palette dirty and bumps a revision. A full
  reset resets the palette, overrides and selection colours.
  `tessera_color_revision`, `tessera_dynamic_colors`.
- `internal/terminalcore/source/snapshot_api.zig`: snapshots carry the
  selection colours. `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `8fe8116b340424ca84c6c8066f6ba75a7ba48fb2d10dc96c59adf0ade5e0a2ef`; rebuilt
  again in task 213).
- `web/terminal-colors.mjs`: `terminalThemeWithProgramColors(base, values)`
  lays a program's colours over the pane's theme; colours it left alone
  follow as the pane's do (cursor and selection the foreground, text on them
  the background).
- `web/terminal-entry.js`: after writes, reset and snapshot restore, a new
  revision recomputes the theme from the pane's original one, updates the
  renderer's theme in place (the prediction overlay and image selection read
  it too) and the padding background, and redraws everything.
- `web/vendor/terminal.js` rebuilt. `README.md`, `CHANGELOG.md`,
  `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: OSC 4 by name and `rgb:`, cells drawn
  in the new colours, queries with BEL and ST, a query changing nothing, 104
  for one entry and all; 10–12/17/19 queries before and after setting, one
  request setting 11 and 12, 13/14 ignored, a snapshot, light mode keeping a
  program's colours, 110/111/117 following the current mode, full reset.
- `web/terminal-colors.test.mjs`: the theme from a program's colours.
- `web/terminal-entry.test.mjs`, real core: OSC 11/12 recolour the theme and
  padding, resets give the pane's colours back, a restored snapshot brings
  them back, reset clears them.
- Full JavaScript suite: 699 pass. `go test ./...` fails only on the
  unembedded `screensaver.mjs`, as before. `npm run verify:terminal-core`
  reproduces the core.
- Real host and shell, headless Chrome over the DevTools protocol: a script
  setting OSC 11, 10, 12 and palette entry 1, then querying 11, 4;1 and 19 in
  raw mode. The pane's background (and padding), text, cursor and red
  turned to the new colours, and the replies came back through the PTY:
  `]11;rgb:2020/3030/4040` with ST, `]4;1;rgb:ffff/6666/cccc` with BEL,
  `]19;rgb:2020/3030/4040` with ST.
- Not yet tried on the iPad.
