# Task 102: Stable terminal symbol fallback on legacy Firefox/macOS

Status: complete

Firefox 115 ESR on macOS High Sierra renders some terminal symbols with an
incompatible system fallback font. In the reported Claude Code status line,
two U+23F5 BLACK MEDIUM RIGHT-POINTING TRIANGLE characters overlap and appear
as corrupted boxed glyphs instead of `⏵⏵`.

## Evidence

- Claude Code's documented Auto mode indicator begins with two U+23F5
  characters.
- Tessera's bundled JetBrains Mono contains no U+23F5 glyph. It is also missing
  most Miscellaneous Technical, Miscellaneous Symbols, and Dingbats codepoints.
- ghostty-web draws each character through Canvas `fillText` at its terminal
  cell origin without clipping it to the cell. Firefox therefore delegates the
  missing glyph to the operating system and trusts that fallback's metrics.
- The screenshot is consistent with High Sierra's fallback glyph exceeding
  Tessera's measured JetBrains Mono cell width.

## Proposed implementation

- Bundle the official unmodified Noto Sans Symbols 2 face and its SIL Open Font
  License with Tessera.
- Add it after the selected monospace face and before the platform `monospace`
  fallback used by terminal canvas rendering.
- Load both the selected terminal face and the symbol fallback before creating
  or remeasuring a terminal.
- Confirm that U+23F5 and representative missing technical, geometric, symbol,
  dingbat, arrow, and braille codepoints come from the bundled fallback.
- Keep ASCII, box drawing, block elements, Powerline glyphs, and all glyphs
  already supplied by the selected terminal font on their current paths.
- Test font descriptors/loading and inspect terminal output in Firefox 115 ESR.
- Document the fallback and verify all frontend and Go tests.

The physical High Sierra machine remains the final confirmation because this
problem depends on Firefox's macOS canvas/font fallback behavior.

## Implementation

- Bundled the official unmodified Noto Sans Symbols 2 Regular face from Google
  Fonts commit `25b00f0` and its SIL Open Font License. The shipped font SHA-256
  is `7d5fb73b7ca67a6798101741f5d280a3d016a56a197afcd4199dbb57b4b82a21`.
- Placed the symbol face after JetBrains Mono or Fira Code and before the
  operating-system monospace fallback.
- Terminal startup and live font changes now wait for regular/bold primary
  faces and regular/bold matching of the symbol face before measuring.
- Constrained arrow, technical, geometric, dingbat, Braille, and supplementary
  symbol glyphs to Ghostty's assigned one- or two-cell canvas width. Narrow
  glyphs remain unscaled; ordinary text and complex-script graphemes remain on
  the original renderer path.
- Added direct coverage tests over the bundled TrueType cmap, load-descriptor
  tests, renderer max-width/restoration tests, explicit embed coverage, and
  user/developer documentation.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (223 tests passed)
- `go test ./...`
- `go build -o .cache/tessera-symbol-fallback.exe ./cmd/tessera`
- `git diff --check`
- Loaded a real Terminal in Firefox 115.37.0 ESR, printed Claude's
  `⏵⏵ auto mode on (shift+tab to cycle)` indicator and representative pause,
  geometric, dingbat, arrow, Braille, ordinary triangle, prompt, and Powerline
  glyphs. The indicator rendered as two distinct cells with no overlap.
- Confirmed the compiled single-file executable serves the embedded font with
  `font/ttf`, the expected byte count/hash, and Firefox reports the face loaded.

Physical Firefox 115 on High Sierra remains the final platform verification.
