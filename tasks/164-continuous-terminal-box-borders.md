# Draw continuous terminal box borders

Status: complete

## Request

Fix the gaps between border characters in terminal applications such as Fresh,
as shown in the native Ghostty versus Tessera screenshot.

## Change

Draw solid light/heavy box-drawing lines, corners, junctions, and half-lines
against cell boundaries through the existing terminal symbol renderer. Preserve
font metrics for normal text and the renderer's colors, selection, inverse,
faint, invisible, and decoration behavior. Keep intentionally dashed, rounded,
diagonal, and double-line glyphs on their existing font path.

## Validation

- Reproduced six empty pixel rows in a three-row vertical border using the
  previous renderer with IBM Plex Mono at 18px in both renderer modes.
- The new border geometry has no gaps across 96 Chromium cases: JetBrains
  Mono, Fira Code, and IBM Plex Mono; 12/14/18/24px; display scales
  1/1.25/1.5/2; Stable and Experimental modes.
- Each case also verifies equal full and incremental canvas pixels and uniform
  faint junction opacity. Browser fixtures, results, and before/after images
  are saved in the ignored `.cache/review/terminal-box-164` directory.
- Three added regressions verify edge connections, connected non-overlapping
  geometry for all 80 supported characters, and renderer styling/invisibility.
- Passed all 486 web tests and `git diff --check`.

This extends the existing separately loaded symbol-renderer module; no WASM or
terminal bundle rebuild is required. Normal text retains its existing font
metrics, including room for accents and descenders.
