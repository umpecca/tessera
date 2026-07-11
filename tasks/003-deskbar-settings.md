# Task 003: Deskbar settings

Status: complete

Add a Settings entry to the Deskbar that opens a Tessera-styled modal. It must
let users set default font size/theme values separately from the active pane's
font size and the current app theme.

The modal stores the default pane font size and default theme in local storage.
New terminal, worksheet, and text-editor panes use the default font size.
Current font changes apply only to the selected compatible pane and retain the
existing workspace persistence; current theme changes apply immediately and
use the existing saved theme behavior.
