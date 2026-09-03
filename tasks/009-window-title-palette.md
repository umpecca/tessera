# Task 009: Window title palette action

Status: complete

Expose the active window title editor clearly in the command palette as
`Set Window Title...` with palette code `WT`. The command opens the existing
persisted title dialog, which is the accessible title-editing path when OLED
Terminal hides a pane's title tab.

The title input takes focus and selects its existing value as soon as the
dialog opens. Palette focus restoration also yields while the title dialog is
visible, so the active pane cannot steal the first keystroke.

Verification:

- `node --check web/app.js`
- `node --test web/*.test.mjs`
