# Task 223: Underline styles and colours

Status: complete (iPad check pending)

## Request

Draw underlines in their style (double, curly, dotted, dashed) and their
own colour, as Neovim uses for errors and spelling, instead of all as one
plain line in the text colour.

## Findings

- The core parses and keeps both: `Style.flags.underline` (Ghostty's SGR
  enum, none to dashed) and `Style.underline_color` (SGR 58, none, palette
  or RGB). The cell reads give the renderer only an underline flag.
- ghostty-web's cell is 16 bytes, decoded in two places (the viewport pool,
  also used by Tessera's one-row reads, and history lines); the last byte is
  padding, always 0, that neither decoder reads. Its renderer strokes one
  1 px line at `baseline + 2` in the text colour (or the selection's) for any
  underline.
- The web build already rewrites ghostty-web's source (the Unicode guard,
  canvas sizing), failing when the pinned text changes.
- A colour doesn't fit in the spare byte; a cell read is decoded straight
  after it, so a side buffer filled by the same read stays in step.
- At 1x, two 1 px strokes two pixels apart on whole-pixel centres blur into
  one band; whole-pixel rectangles stay distinct at 1x and 2x.

## Changes

- `internal/terminalcore/source/underline_api.zig`,
  `scripts/patch-terminal-core.mjs`: the viewport, one-row and history cell
  reads put the style in bits 0-2 of the spare byte and set bit 3 for an own
  colour, written (palette entries resolved) at the cell's index to the
  buffer `tessera_underline_colors` points to. XTGETTCAP reports `Su`,
  `Smulx` and `Setulc` again. `internal/terminalcore/ghostty-vt.wasm`
  rebuilt (core
  `ca42c4e518877923bd1bfa8c2116550449aa9f55cef5a9ba17d882d400253d49`; rebuilt
  again in task 225);
  `web/vendor/terminal.js` rebuilt with it.
- `scripts/ghostty-web-underlines.mjs` (in `scripts/build-web.mjs`): both
  decoders read the byte as `cell.underline` and, only when bit 3 is set,
  the colour as `cell.underline_color`.
- `web/terminal-underlines.mjs` (bundled through `terminal-entry.js`):
  wraps `renderCellText`; a styled or coloured underline is drawn instead of
  ghostty-web's line: two whole-pixel lines a pixel apart, one quadratic
  wave per column (joining across cells), one-pixel dots on even pixels, a
  dash centred in each column, or a coloured plain line where ghostty-web
  draws its own. Kept inside the cell; the text colour ghostty-web chose is
  used when the underline has none, and the fill is put back for the block
  renderer. Plain underlines in the text colour and invisible text are left
  to ghostty-web.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`; notes in tasks 220
  and 222.

## Validation

- `internal/terminalcore/core.test.mjs`: styles and colours in a viewport
  read (curly red, dotted keeping the colour, colour removed by SGR 59,
  single, double by SGR 21, dashed with a palette colour resolved to the
  same green as SGR 32, none after a reset); a one-row read indexed from its
  first cell; a history line. XTGETTCAP `Smulx`, `Setulc`, `Su`. The
  existing one-row test still matches viewport bytes, spare byte included.
- `scripts/ghostty-web-underlines.test.mjs`: both pinned decoders patched
  once, idempotent, failing on a changed decoder.
- `web/terminal-underlines.test.mjs`: plain, absent and invisible
  underlines left to ghostty-web untouched; styled ones drawn without its
  line, other flags kept, at its position, in their own colour or the text
  colour ghostty-web chose; one wave per column, two for a wide character;
  the fill put back; every style inside its cell, including a short row;
  double lines on whole pixels; dots aligned across cells; dashes centred.
- Full JavaScript suite: 739 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome at 1x and 2x: every style, with and without colours, on
  wide characters and reversed text, drawn as intended; the double line
  first blurred into one band at 1x, which led to whole-pixel lines. No
  page errors.
- Not yet tried on the iPad, or in Neovim (not installed here).
