# Task 270: ASCII polygon screensaver

Status: implemented and automated checks pass (2026-11-13); live viewing in a
browser and on the iPad pending.

## Request

Add another screensaver: an ASCII take on the classic early-90s desktop
effect where outlined shapes drift, twist and pass through each other,
leaving trails. Draw it in the terminal's default text color instead of
cycling colors.

## Scope

- A second screensaver alongside the existing mosaic, started from a new
  command palette entry, **Polygon Screensaver** (aliases such as
  "polygons", "lines", "ascii"). The existing **Screensaver** command and the
  mosaic are unchanged.
- Look:
  - A full-screen character grid in Tessera's terminal font at the default
    terminal text size, on the terminal's default background.
  - Every glyph is drawn in the terminal's default text color, taken from the
    user's **Terminal colors** default (dark: light gray on black; light:
    black on white). No other hues.
  - Two closed four-point outlines. Each vertex drifts at its own speed and
    bounces off the screen edges, so the shapes rotate, fold and cross each
    other.
  - Each shape trails a few older copies of itself. Older copies fade by
    glyph weight and opacity, still in the same text color.
  - Line glyphs follow the line's direction (`-`, `|`, `/`, `\`). Vertices
    are marked, and cells where the two shapes cross get a distinct glyph so
    the interconnections stand out. (Built as ASCII staircases with `_`;
    see implementation notes.)
  - The motion steps cell by cell at a modest rate, for a terminal feel
    rather than smooth vector lines.
- Behaves like the existing screensaver: any key, click, tap or mouse
  movement dismisses it; it locks nothing; it restores pane focus; it pauses
  while the page is hidden. With reduced motion it moves much more slowly.
- Code: a separate module, `web/screensaver-polygons.mjs`, listed in
  `web/embed.go` (task 216's lesson), reusing `DismissGuard` and the existing
  overlay behavior where practical. The mosaic code is not refactored beyond
  what sharing needs.
- Tests: `node --test` for the pure parts (vertex bounce, line rasterizing and
  glyph choice, crossing marks, trail fading, grid sizing, color choice), plus
  the Go embed checks.
- Docs: `docs/workspace.md` and `CHANGELOG.md`.
- Not included: idle auto-start, settings to pick between screensavers,
  colors other than the terminal default, sound.
- Approval: the user approved this scope as written ("yes build it as written", 2026-11-13).

## Acceptance criteria

- [x] **Polygon Screensaver** in the command palette opens a full-screen ASCII
  animation of two drifting, crossing outlines with fading trails.
- [x] All glyphs use the Terminal colors default foreground on its
  background, and follow a dark/light change on the next open.
- [x] Dismissal, focus restore and reduced-motion behavior match the existing
  screensaver; the mosaic screensaver is unchanged.
- [x] The module is embedded; `go test ./web/...` (embed checks) and the new
  `node --test` file pass.
- [ ] Checked by eye in a desktop browser (still frames in headless Chromium
  only; the live animation has not been watched); an iPad check is optional.

## Verification

- 2026-11-13:
  - `node --test web/screensaver-polygons.test.mjs`: 8/8 passed (grid sizing,
    shape creation, edge bounce, staircase glyphs, gapless rasterizing, newest
    copy wins and crossings, copy styles, outlines and trail from history).
  - `node --test web/*.test.mjs`: 1060/1060 passed.
  - `go vet ./web/`, `go test ./web/ ./internal/httpapi -count=1`: passed
    (includes the embed and shipped-module import checks).
  - `npm run build:web` and `git diff --check`: passed.
  - Headless Chromium (Playwright's chromium-1254) still frames of the module
    at 1210×834 CSS px, 2x, dark and light, through a scratch harness serving
    `web/`. Headless barely runs `requestAnimationFrame`, so the harness drove
    `render` with synthetic frame times, and detached the resize handler
    because screenshot capture resizes the viewport (which restarts the
    trail). Checked: true black/white backgrounds, connected staircase lines,
    `+` corners, `*` crossings, five copies fading to dots.
- Pending: watch the live animation from the palette in a desktop browser
  (and optionally the iPad), including dismissal and focus return.

## Implementation notes

- Name chosen to describe the effect, not to reuse any product's screensaver
  name.
- `web/screensaver-polygons.mjs`: `PolygonScreensaver` plus pure helpers
  (`polygonGrid`, `createShapes`, `stepShapes`, `snapshotShapes`,
  `rasterizeLine`, `drawLine`, `CellFrame`, `drawShapes`). Corners move in CSS
  pixels at 70–180 px/s; the grid steps 15 times a second (5 with reduced
  motion, at a quarter of the speed). A history of 25 snapshots gives five
  copies six steps apart. Lifecycle (open, fade-out dismiss, close, listeners)
  mirrors `MosaicScreensaver` and reuses its `DismissGuard`.
- Line glyphs changed during the visual check: per-line slope glyphs (`-`,
  `|`, `/`, `\`) made shallow diagonals into `////` clumps, because cells are
  about twice as tall as wide. Lines are now ASCII staircases: `_` runs along
  each row with one `/` or `\` where the line moves to the next row, `|`
  where a steep line stays in its column, and `_` for level lines.
- Trail copies were first three steps apart, which left them mostly hidden
  under the newest copy; six steps apart they read as a trail.
- Colors come from `terminalColorTheme(feature.terminalColorMode)` and the
  size from `feature.defaultPaneFontSize`, read on each open; the element
  reuses the `.screensaver` class (CSS, foreground-focus checks) with an inline
  background.
- Wiring: `web/preferences.mjs` (`feature.polygonScreensaver`),
  `web/command-palette.mjs` (**Polygon Screensaver**, aliases screen saver,
  polygons, lines, ascii), `web/command-palette-icons.mjs`,
  `web/desktop-interactions.mjs` and `web/window-switcher-view.mjs` (overlay
  checks), `web/embed.go`, test fixtures (`application.test-support.mjs`,
  `pane-interaction`, `session-list`, `window-order` tests).
- Docs: `docs/workspace.md`, `CHANGELOG.md`.
