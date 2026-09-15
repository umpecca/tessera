# Task 107: Older Mac performance preset

Status: complete

Add one persistent performance setting for older Retina MacBooks and include
lower-resolution terminal rendering in the preset.

## Requirements

- Expose Standard and Older Mac modes under Settings → Performance.
- In Older Mac mode, cap terminal canvases at 1× device resolution, use a
  steady active cursor, disable terminal smooth scrolling, and stop decorative
  status animations.
- Apply mode changes immediately to open terminals without reconnecting or
  losing their contents.
- Keep font size, theme, keyboard input, wheel sensitivity, and server-owned
  terminal state unchanged.
- Persist the mode per Tessera user and default existing users to Standard.

## Implementation

- Added a Performance section with Standard and Older Mac profiles.
- Added a per-user database field and migration. Existing users retain the
  Standard profile.
- Added live terminal controls for a 1× pixel-ratio cap and steady cursor. The
  resolution change reallocates and fully repaints the canvas without changing
  the grid or reconnecting the terminal.
- Older Mac mode sets terminal smooth scrolling to zero and disables the
  running, reconnecting, and server-check spinner animations through CSS.

## Verification

- `npm run build:web`
- `node --test web/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs scripts/*.test.mjs`
  (228 tests passed)
- `go test ./...`
- `git diff --check`
