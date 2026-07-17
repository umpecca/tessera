# Task 038 — Symmetric terminal fitting

Status: complete

Make Terminal panes use their available width evenly instead of leaving a
noticeably larger blank area on the right.

## Behavior

- Keep the existing configurable terminal padding.
- Do not reserve a separate scrollbar gutter because ghostty-web renders its
  scrollbar inside the terminal canvas.
- Fit only whole character columns and center the unavoidable fractional-cell
  remainder between the left and right sides.
- Continue refitting terminals when panes or fonts resize.
- Keep the implementation outside `node_modules` so dependency installs and
  web bundle rebuilds preserve the behavior.

## Verification

- Unit-test dimension calculation, whole-column rounding, resize behavior, and
  padding handling.
- Rebuild the committed terminal bundle.
- Run the web tests and repository Go tests.

## Implementation summary

- Added a Tessera-owned fit addon that uses the terminal element's measured
  padding and character-cell metrics without ghostty-web's extra 15px
  scrollbar reservation.
- Kept whole-cell column and row sizing, resize observation, and debouncing.
- Centered the canvas so any fractional-cell width is divided evenly between
  both sides.
- Added focused tests for gutter-free fitting, fractional CSS padding, and
  resize decisions, then rebuilt the committed terminal bundle.
- Passed `node --test web/*.test.mjs`, `go test ./...`, and the web bundle
  build.
- Confirmed in a live browser smoke test that a 1px remainder produces equal
  8.5px left and right gaps with the existing 8px terminal padding.
