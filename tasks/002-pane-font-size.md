# Task 002: Per-pane font size

Status: complete

Add compact font-size controls to terminal, worksheet, and text-editor panes.
The font size is bounded from 10px to 24px, takes effect immediately, and is
saved with each pane so it restores with the workspace.

Implemented the controls in each relevant window's status strip, including a
visible terminal strip. Worksheet and text-editor font sizes update through a
pane-scoped CodeMirror CSS value; terminal sizes update the live terminal and
refit its grid. SQLite now persists `panes.font_size`, with an upgrade path for
existing databases and round-trip coverage in the store test.
