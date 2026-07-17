# Task 007: Deskbar palette toggle

Status: complete

Add a command-palette command that toggles the Deskbar button. It is labelled
`Hide Deskbar Button` while visible and `Show Deskbar Button` while hidden, so
the button can always be restored through the keyboard-first palette.

The per-user interface preference is persisted in SQLite and composes with the
existing fullscreen rule: a focused fullscreen pane still hides the Deskbar
automatically.

Implementation notes:

- `user_settings.deskbar_button_enabled` defaults to enabled for existing and
  new users.
- The command-palette toggle uses the existing debounced user-settings API.
- Loading a user restores the saved Deskbar visibility before the workspace is
  displayed.
