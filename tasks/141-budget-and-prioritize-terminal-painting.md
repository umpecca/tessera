# Budget and prioritize terminal painting

Status: complete

## Request

Apply a shared browser painting budget and prioritize the active terminal,
while keeping other visible terminals updating.

## Implementation

- Share approximately 6 ms of painting work per animation frame, checking the
  deadline between complete terminal paints. Preserve unpainted requests.
- Paint the active visible terminal first. If it consumes a whole frame without
  background progress, start a waiting background pane first on the next frame.
  Rotate completed background panes behind the other ready panes.
- Transfer priority through the existing cursor/selection adapter. Preserve
  FPS limits, typing bypass, output coalescing, visibility, redraws, and cleanup.
- Keep idle panes idle and avoid budget clock reads for a single ready pane
  unless FPS limits or diagnostics already need timing.

## Validation

- All 430 JavaScript/core tests passed. Thirteen new regressions cover the
  shared budget, active-first painting, balanced background rotation, costly
  active paints, focus transfer, idle capacity, coalescing, reentrant requests,
  failed paints, visibility/disposal, deferred FPS deadlines, typing bypass,
  and the real terminal adapter's activation hooks. Existing 30 FPS tests at
  30/60/120 Hz and the single-pane timing fast path still pass.
- Three paired headless Chrome runs used four real 160-column × 60-row
  terminal canvases at 2× pixel resolution, requesting 90 full redraws per
  pane. The first paint changed from creation order to the active pane. Every
  final canvas matched, and each background pane received equal paint turns.
- Median per-frame painting work across the three runs fell from 101.1 ms to
  24.9 ms. Per-run 95th-percentile frame work fell from 109.0–149.6 ms to
  32.4–46.7 ms. Median active-paint waiting time fell from 145.7–157.8 ms to
  38.5–42.2 ms. These are isolated full-redraw stress measurements, excluding
  network transport and normal incremental output; fewer intermediate paints
  are intentional. Individual canvas paints remained expensive.
- A separate browser check changed actual terminal output through 20
  generations while forcing one paint per shared frame. All four panes
  finished at generation 20, and their final canvases matched each other and
  a direct full repaint of their latest core state.
- `npm run build:web`, `go test ./...`, `go vet ./...`, JavaScript syntax checks,
  and `git diff --check` passed. The rebuilt bundle includes the scheduler and
  activation adapter.

The budget is cooperative between complete canvas paints. A single expensive
paint can exceed 6 ms; this change limits aggregate work and prioritizes the
active pane while sharing redraw opportunities with background terminals.
