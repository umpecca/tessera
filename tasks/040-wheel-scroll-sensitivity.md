# Task 040 — Configurable wheel scroll sensitivity

Status: complete

Add separate persisted mouse-wheel sensitivity settings for Terminal panes and
CodeMirror-based editor panes.

## Behavior

- Add Terminal wheel speed and Editor wheel speed controls to Settings.
- Persist both settings per user and apply them across all sessions.
- Default both controls to `1.0×`, preserving existing behavior.
- Offer conservative choices from `0.25×` through `4.0×`.
- Apply terminal sensitivity to scrollback, alternate-screen arrow scrolling,
  and terminal mouse-reporting wheel events.
- Apply editor sensitivity to Worksheet and Text Editor panes.
- Keep terminal and editor values independent because they use row-based and
  pixel-based scrolling respectively.

## Verification

- Test sensitivity normalization and wheel delta conversion.
- Test migration, store, and settings API persistence.
- Run frontend syntax/tests, Go tests, and Go vet.
- Smoke-test both controls and their immediate effects in a live browser.

## Implementation summary

- Added separate per-user Terminal and Editor wheel sensitivity columns with
  safely adoptable SQLite migrations and `1.0×` defaults.
- Added Settings controls from `0.25×` through `4×`; changes save automatically
  and apply immediately without remounting panes.
- Scaled Terminal scrollback, alternate-screen arrow input, and mouse-reporting
  wheel sequences while retaining ghostty-web's native behavior at `1.0×`.
- Scaled CodeMirror wheel movement for both Worksheet and Text Editor panes.
- Added normalization/delta tests plus migration, store, and API persistence
  coverage, and included the frontend helper in embedded release assets.
- Passed the JavaScript syntax check, 17 frontend tests, and all Go tests.
- Verified in a live browser that both controls render independently, persist
  as Terminal `0.5×` and Editor `2×`, and that an Editor `2×` setting turns a
  100px wheel gesture into exactly 200px of scroll movement.
