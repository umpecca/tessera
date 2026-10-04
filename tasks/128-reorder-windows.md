# Task 128: Reorder windows around the user's workflow

Status: complete

Allow users to arrange a persistent window order per session. Ctrl/Cmd+Shift+
Up/Down moves the active window earlier/later, while Ctrl/Cmd+L opens the Window
List with Up/Down buttons on each row. Plain arrow keys select rows and
Ctrl/Cmd+Up/Down (with or without Shift) moves the highlighted row. Reordering
keeps the list open, preserves the selected window, and keeps keyboard focus.

Use the same saved order for window cycling, the switcher, Window List,
Deskbar, and other window menus. Minimized windows retain their place and can
be reordered; pending panes are omitted. Stop at the first/last position rather
than wrapping. Keep geometry, stacking, active window, and running contents
intact. New windows append; removed windows leave the remaining order intact.

Reuse the existing ordered pane array and persisted position field. Verify
ordering and boundaries, persistence after reload/session changes, shortcuts,
modal focus, row buttons, and forwarded browser-pane keys.

Implemented by swapping neighboring window objects in the existing pane array.
Window List retains its selected row and focused button across redraws, reports
the new position, and traps Tab/Shift+Tab. Direct reordering shows a brief,
focus-neutral switcher including minimized windows. Browser proxies relay only
the requested Ctrl/Cmd+Shift+Up/Down gesture in addition to existing shortcuts.

Validation:

- All 323 JavaScript/core tests passed, including reorder boundaries, pending
  slots, minimized windows, editor-key passthrough, modal keyboard handling,
  save scheduling, and proxy shortcut behavior.
- Go tests/vet, web build, JavaScript syntax, and diff whitespace checks passed.
- Store regression verifies saved order after reopening SQLite while preserving
  active/minimized state, stacking, geometry, and unchanged document contents.
- Browser checked row-button click and Space activation, both list shortcuts,
  direct active-window shortcuts, cycling in the new order, minimized-window
  reordering/restoration, reload persistence, and forwarding from a real iframe.
- 88 forward/backward Tab steps stayed within enabled Window List controls.
- Desktop (1280×800) and narrow (375×812) layouts fit without horizontal overflow.
