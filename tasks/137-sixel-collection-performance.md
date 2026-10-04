# Task 137: Avoid scanning text-only history for Sixel cleanup

Status: complete

Every terminal write currently checks all cells in both screens and retained
history whenever an image exists. A tiny image therefore makes ordinary output
parsing slower as text history grows, on both the host and browser.

Track pages that may contain Sixel attachments and skip text-only pages during
collection. Preserve the tracking through page copies, reflow, snapshots,
overwrites, erasure, history eviction, alternate screens, and image clearing.
Keep image and fragment budgets and immediate resource reclamation intact.

Rebuild the pinned WASM and browser bundle. Add regressions that move image
fragments across page boundaries and restore them from snapshots. Extend the
core benchmark to compare small writes with retained images at different
history sizes, and record before/after results.

Validation: decoder tests, core/browser tests, Go tests and vet, reproducible
core build verification, and diff checks.

Implemented conservative page membership for Sixel attachments. Placement and
page copies mark destination pages; reflow marks its pages for one collection
pass. Cleanup skips text-only pages and clears stale membership after erasure.
Snapshot import rebuilds this derived cache without changing the TSS2 schema.
The pinned WASM and embedded browser bundle have been rebuilt together.

Added regressions for insertion/deletion across multiple pages and images in
large histories through reflow, snapshots, and history clearing. Added tiny-write
benchmarks for both JavaScript WASM and the Go runtime.

Validation results:

- All 4 native Sixel decoder tests and all 382 JavaScript/core tests passed.
- `go test ./...` and `go vet ./...` passed.
- `npm run build:web` and `npm run verify:terminal-core` passed.
- A differential probe matched original image pixels, fragments, cursor,
  history, dimensions, and image revisions after 86 operations, including
  multi-page edits, resize, snapshot import, alternate screens, and clearing.
- An isolated comparison with the saved original core measured 1,304.264 µs
  before and 71.669 µs after per five-byte write with one image and 9,979 history
  lines: approximately 18.2 times faster. With no images and 9,977 history lines,
  the measurements were 0.133 µs before and 0.131 µs after.
- The Go runtime benchmark measured 157.354 µs per write in its 10,000-line
  retained-image case. Timing results are local parser benchmarks.
- JavaScript syntax and `git diff --check` passed.
