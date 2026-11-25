# Task 292: Blinking (SGR 5) and overlined (SGR 53) text

Status: implemented, awaiting a live check (2026-11-24).

## Request

Sweep item: the core tracks both, but the browser draws neither. Ghostty's app draws overline and does not blink text; xterm blinks. The user chose sweep items #1-#4 ("lets do #1, #2, #3, #4").

## Scope

- Overline: the core sets bit 16 of the cell's spare byte (beside the underline bits) and the browser draws a line along the top of the cell, also in the plain-row fast path.
- Blink: text with SGR 5 hides and shows on a timer that runs only while blinking text was drawn; each tick redraws the pane; a full redraw with none stops it. Steady with prefers-reduced-motion.
- Built in one core rebuild with tasks 289-292 (one core ID change).
- Approval: the user chose this item from the listed sweep items.

## Acceptance criteria

- [x] SGR 53 draws an overline; SGR 55 removes it.
- [x] SGR 5 text blinks; no timer without blinking text; steady with reduced motion.
- [x] Docs and CHANGELOG updated.

## Verification

- `internal/terminalcore/core.test.mjs`: overline is bit 16 of the spare byte,
  alone and with a curly underline; SGR 55 clears it.
- `web/terminal-underlines.test.mjs`: overline drawn along the top in the text
  colour, wide cells, with plain and styled underlines, not for invisible text.
- `web/terminal-plain-renderer.test.mjs`: overlined cells leave the fast path.
- `web/terminal-text-blink.test.mjs` (new): blinking cells noted and hidden;
  timer starts only with blinking text, partial frames don't stop it, a full
  frame without any does and shows the text, off when disabled.
- Not checked visually in a browser (pending, user).
- One core rebuild for tasks 289-292: `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`,
  core `4905925479f658c48b66a58b60eb8c3195c3a1b203f95382be78f552b74cd288`;
  `--check` matches. The first build failed: the new `CSI ! p` parser text has
  a `'$'` literal, which `String.replace` read as a `$'` pattern; added
  `spliceOnce` (literal split/join) to `scripts/patch-terminal-core.mjs` for it.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1165/1165;
  `go test ./...`: pass; `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`:
  clean; `npm run build:web`: succeeded.

## Implementation notes

- Overline: `tesseraUnderline` in `internal/terminalcore/source/underline_api.zig`
  sets bit 16; `web/terminal-underlines.mjs` draws it; `isSimpleCell` in
  `web/terminal-plain-renderer.mjs` excludes it.
- Blink: `web/terminal-text-blink.mjs` (new, bundled into
  `web/vendor/terminal.js`, so no embed entry), installed outermost in
  `web/terminal-entry.js`; 500 ms phases; enabled only when the pane's
  blinking is on (off in Older Mac mode) and without reduced motion.
- Ghostty's app draws overline but does not blink text; blinking follows xterm.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
