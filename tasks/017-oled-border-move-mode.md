# Task 017: OLED border move mode

Status: complete

Remove OLED Terminal's Alt/Option-left-drag move handler. In OLED mode,
right-clicking a visible pane border toggles a pane-local move mode. While
enabled, the next left drag on the pane moves it; regular left drags on edges
and corners continue to resize when move mode is off. Make the active mode
visually apparent and clear it after a move.
