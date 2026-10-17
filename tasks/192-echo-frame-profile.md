# Task 192: Profile the echo frame

Status: complete (measurement only, no code change)

## Request

After task 190, painting the frame for one typed character was the largest
per-keystroke cost left in the browser (about 323 µs in Chrome, measured
with per-function wrappers). Break it down.

## Method

Headless Chrome on the Mac (Apple M4), 164x45 terminal at device pixel
ratio 1, real zsh behind a test server serving an instrumented copy of
`web/`. Three passes:

- 220 typed keys at 70 ms intervals with one timer around
  `renderScheduledFrame`: **~300 µs mean per echo frame**. Wrapping every
  core and renderer call inflated this to ~430 µs.
- A V8 sampling profile of the same run reported only ~63 µs per frame. It
  is unreliable here: inside frames the sampler often cannot walk the stack
  (WASM and canvas calls) and records `(program)`.
- Each piece repeated 2,000 times in the page, timed as a block (hot, so
  lower than the real typing frame):

| Piece | µs |
|---|---|
| Echo write (one character) | 3 |
| Echo write + frame | 113 |
| Frame with nothing dirty | 2.5 |
| `renderLine`, prompt row (~70 glyphs) | 48 |
| `renderLine`, blank row | 1.1 |
| 60 × `fillText` | 39 |
| Sparse row read (`terminal-viewport.mjs`) | 7.2 |
| `getLine`, full viewport (not used on this path) | 101 |
| `getCursor`, `update`, `needsFullRedraw`, all `isRowDirty` | < 0.5 each |

## Findings

- The sparse dirty-row reader works: no full-viewport read happens on an
  echo frame.
- Nearly all of the frame is canvas `fillText`, one call per glyph
  (~0.65 µs each hot). Ghostty repaints each dirty row and the rows above
  and below it, because a row's background fill would erase glyph overhang
  from its neighbors, so one typed character redraws ~2 rows of text.
- WASM reads, dirty checks and the cursor cost under 15 µs together.

## Conclusion

Not worth changing. A frame is 0.1-0.3 ms in Chrome against a ~26 ms
network round trip and a 16.7 ms frame interval. The only real lever is
repainting just the changed cells instead of whole rows (clipped spans plus
the same span on neighbor rows), which risks artifacts with italics, wide
characters, overhanging glyphs and combining marks for well under 1 ms.

Not measured: Safari. WebDriver needs "Allow remote automation" in Safari's
Developer settings; on the iPad it would need a page that runs the block
benchmark and reports back. Revisit only if the iPad diagnostics show
applying or painting above about 1 ms after task 190.
