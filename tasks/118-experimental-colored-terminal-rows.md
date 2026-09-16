# Task 118: Extend the experimental renderer to colored rows

Status: complete

Allow the browser-local Experimental terminal renderer to paint ordinary ASCII
rows with mixed ANSI foreground colors and colored backgrounds. Preserve the
original renderer's two-pass background-before-text ordering, fixed cell
coordinates, and default-background behavior. Merge adjacent cells with the
same background into one fill, and change foreground canvas state only when
the color changes.

Validate color transitions and background runs. Continue to fall back
atomically for styled cells, Unicode, graphemes, wide cells, hyperlinks,
selections, and link highlighting. Stable mode must remain Ghostty's original
renderer with no wrapper on its row-paint path.

Implemented mixed foreground colors with cached canvas color state and merged
contiguous non-default background runs. The renderer validates the complete row
before painting, then retains Ghostty's background-first ordering. Stable mode
continues to inherit the untouched Ghostty method.

Browser canvas measurement on this computer, using a synthetic 70 × 20 TUI
frame with seven foreground colors and two colored background regions, 20
warmups, 60 frames per sample, and seven alternating samples:

- Original-style per-cell painting median: 6.062 ms/frame
- Experimental color-aware painting median: 5.015 ms/frame
- Median reduction: approximately 17.3%

This isolates canvas row painting and is not a whole-application or Firefox ESR
measurement. Validation: 243 frontend tests, the production web build, all Go
tests, embedded web assets, and `git diff --check` passed.
