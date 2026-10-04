# Task 127: Simplify Settings and contain keyboard focus

Status: complete

Lead Settings with everyday font, theme, terminal appearance, scrolling,
background, clipboard, and performance-profile preferences. Put renderer
experiments, output/paint coalescing, the terminal backlog budget, and TERM
under collapsed Advanced controls. Put compatibility checks and timing capture
under collapsed Diagnostics; run live checks only while Diagnostics is open.

Keep Tab and Shift+Tab inside Settings, skip disabled and hidden controls,
support the disclosure summaries from the keyboard, and close on Escape.
Preserve focus, scroll position, and disclosure state when settings redraw.
Return focus to the invoking control or active pane after closing, without
stealing focus from another overlay. Verify behavior with regression tests and
desktop/narrow-screen browser checks.

Implemented collapsed native disclosures, deferred live diagnostics, Settings
focus containment and dismissal, redraw state restoration, and stacked labels
and controls on narrow screens. Existing preference storage and save behavior
remain intact.

Validation:

- All 315 JavaScript/core tests passed, including seven Settings regressions
  for focus boundaries, hidden/disabled controls, overlay handoff, dismissal,
  redraw state, and diagnostic timer/measurement lifecycle.
- Web build, JavaScript syntax check, Go tests/vet, and diff whitespace checks passed.
- Browser verification completed 200 forward/backward Tab steps with the
  disclosures closed and expanded, with every step inside Settings.
- Confirmed Enter/Space disclosure controls, Escape dismissal and focus
  restoration, preserved focus after changing font size, and preserved
  disclosure state across redraws.
- Checked everyday and advanced layouts at 375×812 and the desktop layout at
  1280×800 with no horizontal overflow. Browser console had no warnings/errors.
