# Task 120: Restore terminal animation throughput

Status: complete

Remove recent diagnostic and cursor work from the ordinary terminal paint hot
path. Collect paint durations and rolling samples only while Settings is open,
where Compatibility displays them. Keep the Standard scheduler free of clock
reads and sample-array maintenance when measurement is inactive. Reset each
measurement sample when Settings opens.

Make cursor blinking request a one-shot cursor-row invalidation. Do not leave
Ghostty's cursor invalidation flag enabled during unrelated output frames.
Preserve the managed cursor timer, Older Mac frame cap, full redraw recovery,
and on-demand diagnostics.

Implemented opt-in paint measurement. Standard terminals now perform no timing
clock reads or rolling-sample array work while Settings is closed. Opening
Settings resets and enables a fresh measurement sample for every terminal;
closing it disables collection again. The 30 FPS Older Mac deadline retains
the clock read it requires for pacing.

Cursor invalidation is now pending for exactly the frame requested by the
managed blink timer and is cleared afterward. Ordinary output frames no longer
ask Ghostty to repaint a clean cursor row.

Validation:

- 247 frontend tests passed
- `go test ./...` passed, including embedded web assets
- Production web bundle rebuilt
- Live Settings check confirmed on-demand samples update and use the revised
  measurement label
- `git diff --check`
