# Toggle maximization with a title-bar double-click

Status: complete

## Request

Double-left-click a window title bar to maximize it or restore it if already
maximized.

## Change

Replace the title-bar double-click minimize action with the existing
maximize/restore toggle. Ignore other mouse buttons, title-bar control buttons,
and title fields being renamed. Preserve undecorated full-size windows; when
their title bar is hidden, Alt+F10 and the command palette provide restoration.
Capture title-bar drags on the title tab so browser click events reach the
double-click handler instead of being redirected to the pane body.

## Validation

- Real Chromium mouse checks passed for Operator, Studio, and Next Tessera:
  title and grip double-clicks maximize, the full-state handler restores saved
  geometry, and non-left clicks, controls, and title renaming are excluded.
- Verified title dragging still moves the window without resizing it, subsequent
  double-clicks maximize, and Alt+F10 restores the dragged geometry.
- Verified maximized panes keep their hidden title bars. Restore-state event
  handling was checked with a dispatched double-click on the hidden title;
  physical restoration uses the existing shortcut or command palette.
- Passed all 489 web tests and `git diff --check`.
- The browser check is saved in the ignored
  `.cache/review/title-double-click-166/live.cjs` file.
