# Task 129: Drag to reorder Window List

Status: complete

Allow mouse dragging from a Window List row's grip or name to insert it at any
position. Show the dragged row and insertion boundary, keep the list open and
the moved row selected, and save once on a changed drop. Canceled and unchanged
drops leave the order intact. Include minimized windows, preserve pending slots,
active pane, geometry, stacking, and contents. Retain row buttons, shortcuts,
modal focus containment, and per-session persistence. Check actual browser
dragging, cancellation, reload persistence, and narrow layouts.

Implemented with a pointer gesture that starts after five pixels of movement.
Rows show grips, a dimmed source, and an insertion line; the list scrolls near
its edges during dragging. Drop inserts the same pane object into the saved
order, with a single save only when changed. Escape, pointer cancellation,
outside drops, and lost capture cancel. Ordinary clicks still open windows;
row buttons retain their click behavior. Drop keeps focus inside the list.

Validation:

- All 332 JavaScript/core tests passed; syntax, web build, and whitespace checks
  passed. Regressions cover insertion across multiple windows, pending slots,
  minimized state, thresholds, button passthrough, pointer identity, insertion
  feedback, cancellation, Escape, outside drops, and edge scrolling.
- Actual browser drags by grip and name worked in both directions, including
  first/last positions and minimized rows. Outside and unchanged drops left the
  persisted revision unchanged. Reload restored the changed order.
- Saved active pane, geometry, stacking, minimized state, and all document
  contents were preserved. Row buttons, list shortcuts, ordinary row clicks,
  and the global active-window shortcut remained functional.
- Desktop and 375×812 layouts fit; focus stayed inside the modal after dragging
  and Shift+Tab. Browser console had no warnings or errors.
