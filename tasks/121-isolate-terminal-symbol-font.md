# Task 121: Isolate the terminal symbol font

Status: complete

Keep the bundled High Sierra symbol fallback available for the characters that
need it without including that fallback in every ordinary terminal cell's
canvas font stack. Ordinary text should use the selected monospace face alone.
Temporarily select the symbol stack while drawing a constrained symbol, restore
the primary stack immediately afterward, and retain the cell-width constraint.

Declare the symbol face's Unicode range so browsers can skip it while shaping
ordinary ASCII. Apply font changes to existing terminals through the same split
primary and symbol stacks.

The renderer patch now rejects ordinary codepoints before reading cell metrics
or running block geometry. Rapidly changing bold and ANSI-colored ASCII thus
uses Ghostty's direct renderer with only one range check.

The canvas font-stack benchmark showed no repeatable cost from the longer font
string by itself. Inspection instead identified the renderer wrapper's metrics
and geometry work on every cell as the shared Stable and Experimental cost.

Validation:

- 249 frontend tests passed
- `go test ./...` passed, including embedded web assets
- Production web bundle rebuilt
- Focused tests verify the primary/symbol font split, symbol-state restoration,
  and the ordinary-cell fast rejection before any metrics access
- `git diff --check`
