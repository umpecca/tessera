# Task 008: OLED dock geometry

Status: complete

Make docked panes respect OLED Terminal's hidden title tabs. OLED uses a zero
top inset, while other themes retain the normal 24px title-tab inset.

Existing docked panes are recognized by their saved dock geometry and reflowed
when a workspace loads or the theme changes, so top, left, right, and bottom
docks remain flush with the intended edges.
