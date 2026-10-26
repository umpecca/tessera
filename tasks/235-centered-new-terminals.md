# Task 235: Centered new windows

Status: complete

## Request

On the desktop and iPad, open a new terminal window centered, taking half
the screen both ways; then the same for browser and VNC windows created
from the command palette.

## Findings

- `createTerminalPane(x, y)` made every terminal 640×360; callers placed
  it at `paneSpawnPoint()`, a cascade from the top left (palette, shortcuts,
  update prompt, phone **+**), or at the right-click point (desktop menu).
- Browser and VNC windows (720×480) share the cascade, and also open from a
  terminal link, the local-port help and the right-click menu.

## Changes

- `web/app.js`: `centeredPaneBox(bounds)`: half the board's width and
  height, at least 360×220 and never more than the board, centered and
  below the tab height. `createTerminalPane(point, options)` uses it, and
  keeps only the corner when given a point (the right-click menu, which
  now also centers when it has no point). `paneBox(point, width, height)`
  does the same for `createBrowserPane(point)` and `createVNCPane(point)`;
  only the palette's New Browser and New VNC pass no point, so links, help
  and the right-click menu keep their places at 720×480.
- `CHANGELOG.md`.

## Validation

- `web/new-terminal-geometry.test.mjs`: desktop, iPad, small and tiny
  boards; centered with and without options; a right-click point keeps its
  corner and the tab height; palette browser and VNC windows centered,
  pointed ones at their point and 720×480.
- Full JavaScript suite: 797 pass. `go test ./...` passes.
- Real host, headless Chrome: New Terminal from the palette on a 1400×900
  desktop opened 700×450 at 350,225, and on a 1180×820 touch iPad view
  590×410 at 295,205; New Browser and New VNC from the palette opened at
  the same places and sizes.
