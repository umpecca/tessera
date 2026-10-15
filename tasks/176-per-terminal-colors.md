# Per-terminal window colors

Status: complete

## Request

Add per-terminal window themes. Scope confirmed as terminal colors only.

## Behavior

- Terminal and window context menus offer Terminal colors: Use default, Dark,
  and Light, using the existing neutral xterm palette.
- Each pane starts by following the user default. Explicit choices persist
  with that session through saves/reloads and remain independent when the user
  default changes. Use default clears the override.
- Color changes recreate the selected browser terminal view, reconnecting to
  the managed shell and replaying retained output without ending the shell.
- Migration 048 defaults existing panes to inheritance; unknown imported color
  modes normalize to inheritance.
- Terminal attachment carries the effective color mode so the host configures
  retained cells immediately, even before the debounced pane save completes.

## Validation

- Store checks cover independent pane choices, reloads, reset to inheritance,
  invalid imports and migration of legacy panes without changing their content
  or revisions. Legacy migration fixtures return to their original schema
  before upgrade.
- Frontend regressions cover selection/reset, menus, the effective attachment
  mode, and leaving explicit views connected when the user default changes.
- A real PTY/WebSocket regression checks configuration changes and fallback
  while retaining the same shell epoch.
- Headless Edge validates mixed Light/Dark panes, readable retained text,
  shell continuity, persisted choices, reload and reset from the window menu.
  The UI check and screenshot are in `.cache/review/pane-colors-176`.
- All 564 JavaScript/core tests, Go tests, Go vet, syntax and diff checks pass.
