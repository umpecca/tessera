# Task 046: Terminal navigation keys

Status: complete

Make the Home, End, Page Up, and Page Down keys work correctly when a Terminal
pane has focus.

## Requirements

- Pressing Home in a focused terminal sends the appropriate terminal input to
  move to the beginning of the current command line.
- Pressing End in a focused terminal sends the appropriate terminal input to
  move to the end of the current command line.
- Pressing Page Up or Page Down in a focused terminal sends the appropriate
  terminal input for the running terminal application.
- Preserve modified navigation-key combinations and existing application
  shortcuts.
- Do not interfere with navigation-key behavior in text editors or other panes.
- Add focused regression coverage for terminal keyboard handling.

## Verification

- Run the focused frontend keyboard tests.
- Run the complete web test suite and relevant repository tests.
- Run `git diff --check`.

## Implementation summary

- Added a Tessera-owned logical-key fallback for unmodified Home, End, Page Up,
  and Page Down events so navigation-cluster keys work even when the browser
  reports numpad physical key codes.
- Left modified navigation combinations and non-terminal panes on their
  existing keyboard paths.
- Embedded the new browser module and added focused coverage for sequences,
  numpad-origin events, modifiers, and unrelated keys.
- Passed `node --test web/*.test.mjs`, `node --check web/app.js`, `go test ./...`,
  and `git diff --check`.
