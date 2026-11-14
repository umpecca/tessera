# Task 268: Default to Departure Mono and 14px text

Status: implemented; browser visual check pending (2026-11-13).

## Request

Make the default text size 14 and the default font Departure Mono.

## Scope

- Default font: change the default from JetBrains Mono to `departure-mono` in
  `web/terminal-font.mjs` (`defaultTerminalFont`) and `internal/store/session.go`
  (`DefaultTerminalFont`). Since the selected font applies throughout Tessera,
  this changes both terminals and interface text.
- Default text size: the default terminal pane size is already 14px, so this
  changes the **interface** text size default from 12 to 14px in
  `web/interface-font.mjs` and `internal/store/session.go`
  (`DefaultInterfaceFontSize`). The 10–18px range stays the same.
- New users' settings rows store the new defaults. The settings-row `INSERT`
  in `session.go` now writes `interface_font_size` explicitly, because the
  column's SQL default (migration 058) is 12.
- Out-of-range or unknown stored values fall back to the new defaults.
- Not included: no migration rewrites existing users' saved font or size, and
  old migrations stay unchanged. Users who already have a settings row keep
  JetBrains Mono / 12px until they change them.
- Update the docs (`docs/terminal.md`) and `CHANGELOG.md`, and the tests that
  assert the old defaults.
- Approval: user approved this scope as drafted (2026-11-13).

## Acceptance criteria

- [x] A new user with no saved settings gets Departure Mono and 14px interface text.
- [x] An unknown font value normalizes to Departure Mono, and an out-of-range interface size normalizes to 14, on both web and server.
- [x] Existing saved settings are unchanged.
- [x] The docs and changelog describe the new defaults.

## Verification

- `node --test web/*.test.mjs`: 1052 passed, 0 failed.
- `go test ./internal/store/ ./internal/httpapi/`: both ok. `go vet ./internal/store/`: clean.
- `npm run build:web`: succeeded. It rewrote the tracked
  `web/extensions/tessera-clipboard-dev.zip`, which was restored because it is
  unrelated to this task.
- Not done: a browser visual check of 14px Departure Mono for a fresh user.

## Implementation notes

- The interface scale used to be `size / defaultInterfaceFontSize`. With a
  default of 14, that would have made the default look the same as before. The
  web side now has a separate `baseInterfaceFontSize = 12` (the size the styles
  are drawn at) for the scale, and `defaultInterfaceFontSize = 14`.
- `web/styles.css` `:root` now sets `--tessera-ui-font-scale: calc(14 / 12)` and
  `--tessera-font` to Departure Mono, so pages loaded before user settings
  (e.g. sign-in) match the new defaults.
- Unset values take the new defaults. That includes phone settings saved
  before migration 058 that never stored an interface size: these now resolve
  to 14 instead of 12. Existing desktop rows keep the column's stored 12.
- Changed files: `web/terminal-font.mjs`, `web/interface-font.mjs`,
  `web/preferences.mjs`, `web/styles.css`, `internal/store/session.go`, tests
  (`web/terminal-font.test.mjs`, `web/interface-font.test.mjs`,
  `web/settings-font.test.mjs`, `internal/store/interface_font_test.go`),
  `docs/terminal.md`, `CHANGELOG.md`.
- Departure Mono is designed for 11px (sharpest at 11/22px), so 14px text
  may look slightly soft. That is the size requested.
