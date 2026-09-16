# Task 119: Add hybrid terminal rows and path diagnostics

Status: complete

Extend the browser-local Experimental renderer so one styled, Unicode, wide,
or linked cell does not force an otherwise ordinary row through Ghostty's full
row renderer. Preserve background-before-text ordering, use the optimized path
for simple ASCII cells, and delegate only complex cells to Ghostty's existing
cell methods. Keep full-row fallback for selections, detected link highlights,
fully complex rows, and renderers without compatible cell methods.

Track fast, hybrid, and original row counts for Experimental terminals and
show counts and percentages in Compatibility and copied diagnostics. Reset the
counters when Experimental mode is newly enabled. Stable mode must continue to
use Ghostty's original `renderLine` method directly.

Implemented a two-pass hybrid row path. Simple ASCII cells retain merged
backgrounds, cached foreground state, and fixed-coordinate text painting;
complex cells call Ghostty's existing background and text methods in their
original pass. Fully complex or globally highlighted rows continue through the
original row method.

Experimental terminals now expose cumulative fast, hybrid, and original row
counts and percentages in the Compatibility panel and copied diagnostics. A
live terminal check with colored and Unicode output reported all three paths
(89.0% fast, 6.8% hybrid, and 4.1% original in that short sample).

Validation:

- 246 frontend tests passed
- Production terminal bundle rebuilt
- `go test ./...` passed, including embedded web assets
- Live renderer selection, terminal output, and Compatibility diagnostics check
- `git diff --check`
