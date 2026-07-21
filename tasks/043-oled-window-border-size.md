# Task 043: OLED window border size setting

Status: complete

Add an appearance setting to the settings modal that controls the visible
window border size for panes when the `OLED Terminal` theme is active.

## Requirements

- Show the border-size control in the settings modal with the other appearance
  settings.
- Persist the selected value through the existing settings mechanism.
- Apply the configured size to OLED Terminal pane/window borders without
  changing the border appearance of other themes.
- Preserve the current OLED Terminal border size as the default so existing
  users see no visual change until they adjust the setting.
- Add or update focused tests for settings persistence and theme application.

## Verification

- Run the relevant frontend tests and build/type checks.
- Run `git diff --check`.

## Implementation summary

- Added a 1–20px OLED border stepper to the Theme section of the settings
  modal, preserving the existing 10px border as the default.
- Applied the setting immediately through one CSS custom property shared by
  the visible border and all OLED resize hit targets.
- Persisted the value in user settings with a SQLite migration and matching
  client/server normalization.
- Added frontend normalization tests and extended store/API/migration coverage.
- Added the new browser module and web manifest to the embedded asset set, with
  a regression test that prevents either request from falling through to the
  SPA HTML response.
- Passed all frontend tests, `node --check web/app.js`, `go test ./...`,
  `go vet ./...`, and `git diff --check`.
