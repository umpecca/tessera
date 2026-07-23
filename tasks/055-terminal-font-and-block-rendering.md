# Task 055: Terminal font and block rendering

Status: complete

Make Tessera's browser terminal visually match desktop Ghostty more closely by
using JetBrains Mono, measuring only after the font is loaded, and rendering
solid Unicode block elements as exact cell geometry without seams.

## Requirements

- Bundle JetBrains Mono locally from the official Google Fonts source together
  with its SIL Open Font License; do not require a runtime CDN connection.
- Make JetBrains Mono the default terminal font while retaining Fira Code as a
  user-selectable terminal font.
- Add a validated, persisted per-user terminal font setting and expose it in
  the Settings UI.
- Apply font changes to live terminal panes and use the selected font for newly
  created panes.
- Wait for the selected regular and bold web fonts before Ghostty Web measures
  and opens a terminal, preventing fallback-font metrics from becoming fixed
  in the canvas.
- Add a Tessera-owned, idempotent Ghostty Web renderer extension that draws the
  solid Unicode Block Elements range as pixel-aligned cell rectangles.
- Cover upper/lower fractional blocks, left/right fractional blocks, full
  block, and quadrant combinations; leave shade characters on the font path.
- Keep the renderer extension outside `node_modules` and generated vendor
  bundles.
- Preserve text attributes, colors, selection foreground, and ordinary glyph
  rendering.
- Document the terminal font setting and rendering behavior.

## Verification

- Add focused tests for terminal font normalization and font descriptors.
- Add geometry tests for every supported solid Block Elements code point and
  verify shade/ordinary characters remain on the normal renderer path.
- Add store, migration, and HTTP API tests for terminal font persistence.
- Run all web tests, `node --check web/app.js`, the complete Go test suite, and
  `git diff --check`.

## Implementation

- Bundled the official JetBrains Mono variable font and SIL Open Font License,
  made it the default, and retained Fira Code as a selectable alternative.
- Persisted the validated font ID per user and exposed a live Settings control.
- Waited for regular and bold faces before terminal construction and refit open
  terminal panes after font changes.
- Installed an idempotent Tessera renderer extension over Ghostty Web that
  draws solid block elements as pixel-aligned rectangles while preserving the
  normal path for shade and ordinary glyphs.
- Added focused frontend geometry/font tests and backend migration, store, and
  HTTP API persistence tests.

## Verification results

- `node --test web/*.test.mjs` (43 tests passed)
- `node --check web/app.js`
- `npm run build:web`
- `go test ./internal/store ./internal/httpapi`
- `go test ./...`
- `git diff --check`
