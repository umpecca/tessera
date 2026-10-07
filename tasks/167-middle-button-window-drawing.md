# Draw windows over other panes with the middle mouse button

Status: complete

## Request

Hold the middle mouse button and drag to create a window over existing panes
without interfering with their left-click handlers.

## Change

- Capture middle-button drags on the desktop before pane controls receive them.
- Reuse the existing window outline, geometry, and type picker after release.
- Start the outline after movement so a simple middle click creates nothing
  and leaves the active pane unchanged.
- Relay the gesture from sandboxed Browser content as well.
- Suppress middle-button browser actions and discard canceled outlines.
- Preserve existing left-button drawing on the empty desktop and normal pane
  left-click/drag interactions.

## Validation

- All 495 web tests pass, including drawing geometry, the movement threshold,
  simple clicks, pointer identity, cancellation, left-button behavior, and the
  Browser relay's capture, coordinate translation, and canceled gestures.
- HTTP API tests and vet pass; the Windows application builds successfully.
- Live Chromium mouse checks pass for editor content, terminal content,
  undecorated maximized Operator panes, and proxied Browser content. Verified
  type selection, preserved left clicks, Escape cancellation in terminal and
  Browser content, iframe capture while dragging outside its bounds, and no
  browser tab opening when the gesture starts on a link.
