# Task 111: Pause covered terminal rendering

Status: complete

Pause canvas painting and cursor blinking when a higher opaque pane fully
covers a terminal. Continue processing output. Recheck after moving, resizing,
raising, minimizing, restoring, creating, or closing panes, coalesced into one
animation frame. Force a full redraw when exposed. Coverage is conservative:
partially covered panes and panes covered only by a combination of windows
continue rendering.
