# Task 066: Synchronize active pane focus

Status: complete

Keep Tessera's visually active pane synchronized with the browser's actual
keyboard focus while switching windows and dismissing navigation overlays.

## Requirements

- Focus Terminal and editor panes through their native view APIs.
- Focus Browser, File Browser, Audio, and other panes through an appropriate
  pane-owned DOM target.
- Restore focus to the active pane when the command palette or window list is
  dismissed without selecting another control.
- Preserve modal focus and normal pointer-driven focus behavior.
- Cover the pane-type focus decisions with focused tests.

## Verification

- Added pane-aware focus routing for Terminal, editor, Browser, File Browser,
  Audio, and generic pane containers.
- Restored active-pane focus after command-palette and window-list dismissal
  when focus did not move elsewhere.
- Focused panes activated through title dragging and resizing.

## Verification results

- `node --test web/*.test.mjs` (69 tests passed)
- `node --check web/app.js`
- `node --check web/pane-activation.mjs`
- `npm run build:web`
- `go test ./...`
- `git diff --check`
