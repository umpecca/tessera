# Task 262: Command palette item icons

Status: complete (2026-11-11).

## Request

Add appropriate icons to command palette items so actions and window types are
easier to identify at a glance.

## Scope

- Add compact, consistent monochrome SVG icons beside command palette labels,
  including built-in actions, terminal shortcuts, session/user switching and
  window entries with icons appropriate to their pane type.
- Match existing themes and selection colors; preserve readable labels, hints,
  shortcut codes, search/ranking, keyboard navigation and click behavior.
- Treat icons as decorative for accessibility; use local SVG paths without
  external assets or dependencies. Do not change the Command Wheel or other menus.
- Add regression coverage and update relevant docs and the changelog.
- Do not restart active servers, commit or push.
- Approval: user confirmed this scope with “yes”, then directed “try again”.

## Acceptance criteria

- [x] Command palette rows show appropriate, consistently aligned icons.
- [x] Labels, hints and codes remain legible at narrow widths and in supported
  themes; icons do not alter accessible command names.
- [x] Search, selection and activation behavior remain unchanged, with regression
  coverage and relevant checks passing.

## Verification

- `node --test web/*.test.mjs`: 1,043 passed, zero failed. Log:
  `$TMP/task262-web-tests.txt`. New tests cover built-in and dynamic icon choices,
  restore toggles, local SVG/accessibility attributes, text/code preservation,
  filtering, selection, keyboard and click activation, and empty results.
- `npm run build:web`: passed with `$TMP/tessera-go-1ovo0srj/go/bin` on PATH.
- `go test ./web ./internal/httpapi`: passed, including recursive embedding and
  versioned-import checks for the new module. Go executable:
  `$TMP/tessera-go-1ovo0srj/go/bin/go`.
- `go build -o $TMP/tessera-palette-UD9L4o/tessera ./cmd/tessera`: passed.
- `node scripts/frontend-smoke.mjs` against that binary and the existing
  temporary Playwright installation: passed, including fonts/themes, Settings,
  Window List, pane activation, reconnect, phone modes and native-style commands;
  no uncaught browser errors. Output directory:
  `$TMP/tessera-palette-UD9L4o/frontend`.
- `node scripts/command-palette-smoke.mjs
  --binary=$TMP/tessera-palette-UD9L4o/tessera
  --playwright=$TMP/tessera-browser-cUa7BM/node_modules/playwright/index.mjs
  --output=$TMP/tessera-palette-UD9L4o/browser-scaled` with
  `PLAYWRIGHT_BROWSERS_PATH=$TMP/tessera-browser-cUa7BM/browsers`: passed in
  Chromium 158.0.8127.18 and WebKit 27.2 at all three widths and both sizes, with
  all six theme-style previews. No row overflow/overlap; icon strokes follow text
  color and scale; keyboard selection/Enter, clicking the icon, decorative
  accessibility and empty results passed. Screenshots/results:
  `$TMP/tessera-palette-UD9L4o/browser-scaled/home-MX7jeQ`.
  Initial harness issues corrected: scope palette selectors separately
  from Window/Session List; compare icon dimensions to the scaled root font size,
  not the numeric interface preference (Tessera scales 16px rem units).
- Visually reviewed Chromium screenshots of desktop Operator and narrow
  Next Tessera palettes: consistent outline icons, theme colors and truncation.
- `git diff --check`: passed after task finalization.
- `$TMP` is
  `/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode`.

## Implementation notes

- Existing palette rows contain a label plus hint/code metadata. Additions should
  preserve the shared command model consumed by the Command Wheel.
- Added local SVG path/mapping module `web/command-palette-icons.mjs`, explicitly
  embedded in `web/embed.go`. Icons use `currentColor`, a common grid/stroke,
  `aria-hidden` and `focusable=false`; no assets fetched or dependencies added.
- `web/command-palette.mjs` renders an icon/text label group and adds presentation
  metadata to dynamic session/user/shortcut/window commands and restore toggles.
  Labels, matching, codes, ranking, activation and the Command Wheel are unchanged.
- `web/styles.css` keeps icons fixed within each row, scales them with interface
  text, and permits long labels/hints to ellipsize without hiding shortcut codes
  or overlapping. Updated `docs/workspace.md` and `CHANGELOG.md`.
- Added `web/command-palette.test.mjs` and an isolated Chromium/WebKit smoke script
  covering all six theme styles, 320/390/1280px widths, interface sizes 12/18,
  long titles/hints, filtered/empty results and clicking the icon itself.
- No active servers restarted; no commit/push. Earlier task changes preserved.
- No pending automated checks. Browser checks are desktop Chromium/WebKit with
  real embedded assets, not physical-iPad acceptance; no native code was changed.
