# Remove decorations from full-size Operator windows

Status: complete

## Request

Make full-size Operator windows use the same undecorated window presentation
as OLED Terminal.

## Change

- Hide the title bar and its controls when an Operator pane is full-size.
- Remove the outer border, rounded corners, and shadow in that state.
- Remove the title-bar content inset for terminal and other pane bodies.
- Preserve the existing Alt+F10 and command-palette restore actions; normal
  windows regain their Operator decorations when restored.

## Validation

- Passed all 12 existing Operator integration and window-wobble tests.
- Chromium layout checks passed at desktop and touch sizes for Terminal,
  Worksheet, File Browser, Text Editor, Browser, VNC, and Audio panes.
- Verified hidden title bars and resize targets, zero borders/shadows/radii,
  no top content gap, full-height terminals, matching OLED content insets,
  theme switching while maximized, and reinstated decorations on restore.
- Passed `git diff --check`. The temporary browser check is saved in the
  ignored `.cache/review/operator-full-163/check.cjs` file.
