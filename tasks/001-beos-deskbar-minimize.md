# Task 001: BeOS-style minimize recovery

Status: complete

Replace Tessera's in-place windowshade with a true minimized state. Minimized
panes must disappear from the canvas, persist across reloads, and be restored
from a compact BeOS/Haiku-inspired Deskbar. Title-tab double-click should
minimize, and pane cycling must skip minimized panes.

Implemented a compact window-list Deskbar with a minimized count badge,
true hidden-pane behavior, Deskbar restoration, and double-click title-tab
minimizing. The minimized flag persists in SQLite and visible-pane cycling
skips hidden panes. Verified with `node --check web/app.js`, `go test ./...`,
and the local browser flow (minimize, restore, reload, title-tab minimize).

Follow-up: moved the Deskbar control to the bottom-right so maximized pane
controls remain unobstructed.
