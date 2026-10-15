# Smooth terminal scrolling

Status: complete

## Request

Make terminal scrolling smooth, predictable, and polished for wheels and trackpads.

## Behavior

- Use the same smooth scrollback path at every saved wheel speed.
- Accumulate rapid gestures without losing distance; reverse direction promptly.
- Animate using elapsed time, paint fractional rows, and keep the scrollbar fixed.
- Cancel pending motion on explicit navigation, reset, resize, hide, and disposal.
- Respect reduced motion and leave full-screen terminal mouse/arrow input discrete.
- Keep history in view while output arrives; typing resumes following output.

## Validation

Cover gesture accumulation, reversal, boundaries, frame rates, reduced motion,
lifecycle cancellation, fractional painting, and existing renderer integration.
Build the terminal bundle and verify in a real browser.

## Implementation and results

- Added elapsed-time easing to the shared terminal paint scheduler. All wheel
  speeds preserve fractional input, accumulate gestures, and reverse promptly.
- Paint partial text/image rows on the physical pixel grid; selection and link
  hit tests follow those pixels. Scrollbar fades use the same scheduler.
- Normalize pixel/line/page input for TUI wheel reporting and arrow fallback,
  accumulating small trackpad deltas into discrete input.
- Keep history visible during output, shift positions as retained history grows,
  and resume following output on typing. Explicit navigation and lifecycle
  changes discard pending motion.
- Respect system reduced motion and an explicit zero animation duration.
- Rebuilt `web/vendor/terminal.js`; all 576 JavaScript/core tests, Go tests,
  Go vet, frontend syntax and diff checks pass.
- Headless Edge at 1.25 device scale verifies intermediate scroll positions,
  complete burst distance, reversal, partial-row selection, both renderers,
  Sixel fragments, live-output stability and reduced motion without errors.
  The browser harness and screenshot are in `.cache/review/scroll-177`.
