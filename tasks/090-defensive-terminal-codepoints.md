# Task 090: Defensively render invalid terminal code points

Status: complete

`ghostty-web` 0.4.0 converts renderer and viewport cell values with unchecked
`String.fromCodePoint` calls. If its WASM viewport returns a corrupt value above
Unicode's scalar range, opening or using a terminal throws a `RangeError` and
the pane becomes unavailable.

## Requirements

- Validate every code point converted by the bundled `ghostty-web` module.
- Preserve valid Unicode scalar values, including multi-code-point graphemes.
- Replace negative, non-integer, out-of-range, and surrogate values with
  Unicode replacement character `U+FFFD` instead of throwing.
- Apply the compatibility patch automatically during `npm run build:web` so it
  survives clean dependency installs and terminal bundle rebuilds.
- Defend Tessera's terminal-link adapter from the same invalid cell values.
- Add focused tests for valid BMP/astral text, graphemes, and invalid values.

## Verification

- Run the focused Node tests and the complete `web/*.test.mjs` suite.
- Rebuild the committed web bundles.
- Run JavaScript syntax checks, `go test ./...`, and `git diff --check`.

## Implementation

- Replaced the direct esbuild command with a small build driver that intercepts
  the installed `ghostty-web` ES module and routes all of its
  `String.fromCodePoint` calls through a Unicode-scalar guard before bundling.
  The build fails explicitly if a future dependency version removes or changes
  that expected conversion boundary.
- The guard preserves valid scalar values and grapheme arrays while replacing
  each invalid value with `U+FFFD`, preventing corrupt WASM cell data from
  aborting terminal rendering.
- Added the same defensive conversion to Tessera's wrapped-link adapter and
  advanced the terminal bundle cache key.

## Verification results

- `node --test web/*.test.mjs scripts/*.test.mjs` (164 tests passed)
- JavaScript syntax checks for the build driver, guard, terminal entry point,
  and application entry point
- `npm run build:web`, plus inspection confirming the minified bundle contains
  the integer, Unicode maximum, and replacement-code-point checks
- `go test ./...`
- `git diff --check` (passed with existing line-ending warnings)
