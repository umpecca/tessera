# Task 210: Pointer shape from programs (OSC 22)

Status: complete (iPad check pending)

## Request

Implement OSC 22, which sets the mouse pointer's shape over the terminal.

## Findings

- The core already parses OSC 22 (CSS cursor names and X cursor names such as
  `hand` and `xterm`), ignores unknown names, and keeps the shape on the
  terminal, in snapshots too. The pinned API had no way to read it.
- A full reset did not put the shape back, so a program that crashed with a
  crosshair would leave it after `reset`.
- ghostty-web sets the terminal element's pointer to `pointer` when it moves
  onto a link and to `text` when it leaves, just before setting the
  renderer's hovered link range.

## Changes

- `internal/terminalcore/source/pointer_api.zig`,
  `scripts/patch-terminal-core.mjs`: `tessera_mouse_shape(handle)` returns the
  shape's `MouseShape` value. A full reset sets it back to `text`. Core
  rebuilt with task 209.
- `web/terminal-pointer-shape.mjs`: the CSS cursor name for each value, in the
  enum's order; `text` for anything unknown.
- `web/terminal-entry.js`: after each write, reset and snapshot restore, a
  changed shape is applied to the terminal element. `applyPointerShape` shows
  `pointer` while a link is under the pointer and the program's shape
  otherwise; it runs after ghostty-web's own pointer change (from the hovered
  link range setter, already wrapped) and on mouseleave.
- `web/vendor/terminal.js` rebuilt. `README.md`, `CHANGELOG.md`,
  `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: every CSS name gives the value at its
  place in `terminalPointerShapes` (checks the table against the core); an
  unknown name changes nothing; `hand` gives `pointer`; the shape survives a
  snapshot; a full reset gives `text`.
- `web/terminal-entry.test.mjs`, real core: the element's pointer follows
  OSC 22; a link under the pointer keeps the hand, and leaving it shows the
  program's shape; a restored snapshot brings the shape back; reset gives
  `text`.
- Real host, headless Chrome: `printf '\e]22;crosshair\e\\'` in a terminal
  made the pointer over the text a crosshair.
- Not yet tried in Safari on the iPad or Mac.
