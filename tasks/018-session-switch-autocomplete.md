# Task 018: Session switch autocomplete

Status: complete

Replace the Sessions modal's session list navigation with an autofocus search
field and command-palette-style filtered results. The user should be able to
type a session name, use the arrow keys to select a result, and press Enter or
click a result to switch sessions. Preserve create, rename, and delete actions.

Implemented in `web/app.js` with the command palette's same substring/fuzzy
matching and result ordering. The modal autofocuses its search field; filtered
results retain their management controls, and Arrow Up/Down, Enter, Escape, and
pointer selection work without leaving the field.
