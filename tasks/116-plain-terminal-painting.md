# Task 116: Reduce plain terminal repaint cost

Status: complete

Profile full-row painting and reduce repeated canvas state assignments for
uniform plain ASCII rows. Preserve per-cell coordinates, clear the entire row,
and skip drawing blank glyphs. Fall back atomically to Ghostty's existing path
for styled text, Unicode, graphemes, wide cells, colored backgrounds, mixed
foregrounds, selections, and link highlighting. Install through the terminal
bundle; no new browser API or setting required.

Measurement on this Windows computer in the Codex browser, Fira Code 14px,
70 columns × 20 rows, 1× canvas, forced full redraw, 20 warmup frames and
90 measured animation frames per sample:

- Initial text isolation: normal 5.607/5.839 ms; no text 0.150 ms.
- Alternating comparison: original 3.531/3.566 ms; optimized 2.807/2.557 ms.
- Mean reduction in the paired comparison: approximately 24%.

This is a synthetic plain-text renderer measurement, not whole-application CPU
or a Firefox ESR/High Sierra measurement. Absolute timings varied between runs.
Canvas pixel comparisons from equal cleared states matched exactly at 1×,
1.5×, and 2×. Temporary benchmark assets are not shipped.

Validation: 243 frontend tests passed, including 15 new fast-path/fallback
checks; web bundle build and Go web asset tests passed.
