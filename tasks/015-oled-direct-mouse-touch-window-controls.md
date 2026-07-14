# Task 015: Direct OLED window controls

Status: complete

Make OLED Terminal preserve the same window-control contract as other themes:

- every visible border resizes in its matching axis and visible corners resize
  in both axes;
- do not let the visible top border fall through to generic pane movement;
- keep movement separate from border resizing, with an iPad-compatible mouse
  gesture to be chosen only after the standard border behavior is restored;
- leave non-OLED window chrome and fullscreen behavior unchanged.

Verify the visible hit zones in the browser at mouse and touch-sized layouts.
