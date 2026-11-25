# Task 294: Kitty graphics, second version

Status: implemented, awaiting a check in a browser (2026-11-24).

## Request

After task 293 (Kitty graphics in front of text), the user said "lets do
kitty second version": the three gaps the first version left, images behind
text, the selection over images, and images that are mid-transfer when a
browser reconnects.

## Findings

- Ghostty draws placements in three layers: z < -1073741824 under cell
  backgrounds, other z < 0 between backgrounds and text, z >= 0 over text;
  Unicode placeholder placements at z = -1 (`src/renderer/generic.zig`).
- ghostty-web's `renderLine` is three steps: fill the row, cell backgrounds,
  text. Only Tessera's experimental plain renderer wraps it.
- A snapshot taken partway through an APC string restores the parser in
  `sos_pm_apc_string` with Tessera's APC handler inactive, and
  `apc.Handler.feed` treats inactive as `unreachable`, which is undefined
  behaviour in the ReleaseSmall core (a test against the first version's
  trial core did not trap; what happens to the image was not checked). The
  first version has this bug.
- An image between chunks lives in `storage.loading` (image header, data so
  far, pending display, quiet), which snapshots did not carry.

## Scope

- Core: list placements behind text too; keep the raw bytes of the current
  APC string (up to a cap) and replay them when a snapshot restores the parser
  inside one, or ignore the rest of the string when they were too large;
  carry `storage.loading` in snapshots (format TSS6).
- Browser: `renderLine` with two layers (under cell backgrounds, under text)
  drawn per row inside its own row clip, also in the plain renderer; Unicode
  placeholder placements under text as in Ghostty; the selection drawn over
  images (translucent, as for Sixel), behind or in front.
- Approval: the user asked for the second version described as those three
  gaps.

## Acceptance criteria

- [x] z < -1073741824 images are covered by cell backgrounds, other z < 0 by
      text only, z >= 0 cover text.
- [x] Rows repainted for text changes redraw the behind-text image parts; idle
      rows are not redrawn.
- [x] Selected cells over an image show the selection.
- [x] A snapshot mid-APC restores without trapping and finishes the image;
      one between chunks finishes it too; an oversized APC is ignored safely.
- [x] Docs and CHANGELOG updated.

## Verification

- `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`: core
  `875b5c64bdc2b7f545f01b8782f20667ea3d1f5aac6e8998a9a587ca3b499565`;
  `--check` matches.
- `node --test internal/terminalcore/core.test.mjs`: 64/64. The first
  version's test now expects the z -5 placement listed; new test: a snapshot
  inside an APC string restores and the image arrives with the rest; one
  between chunks (`m=1`) finishes the image and its placement; a string over
  4 MiB is ignored to its end and the text after it prints.
- `node --test web/terminal-sixel-renderer.test.mjs web/terminal-plain-renderer.test.mjs`:
  48/48, new: the row painter's order (fill, under backgrounds, cell
  backgrounds, under text, text) and unchanged without images; layers against
  the real core (z -2000000000 under backgrounds across both rows it covers,
  z -1 under text, z 4 in front, each row clipped), the selection over images
  in front and behind, placeholder images under text; the overlay path sets
  the row hook while rows paint and removes it; the plain renderer's hooks.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1176/1176.
- `go test ./...`: pass (snapshot magic TSS6). `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`: clean.
- `npm run build:web`: succeeded; the row painter is in `web/vendor/terminal.js`.
- Not checked in a real browser (pending, user): `kitten icat --z-index -1`
  and `--z-index -1073741825` over coloured text, selecting over an image,
  reconnecting during a large `icat` transfer.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: z -1 under text over the blue cell background, z -1073741825 under the cell background, z 0 in front; selection translucent over images in front and under text, the selection background covers under-background images; a page reload paused halfway through a chunked transfer and halfway through one APC string, both images finished after reconnect. Not checked: the smooth-scroll row -1 gap.

## Implementation notes

- Core: `internal/terminalcore/source/kitty_api.zig` lists every placement,
  `tessera_apc_raw_limit` and `tesseraKittyResumeApc`, and snapshots
  `storage.loading`; `snapshot_api.zig` saves the APC raw bytes and calls the
  resume when the parser restores in `sos_pm_apc_string`; magic TSS6
  (`source.json`, Go tests, docs). `scripts/patch-terminal-core.mjs`: handler
  `apc_raw` and `apc_raw_overflow`, recorded in `apc_start`/`apc_put`,
  cleared in `apc_end`.
- Browser: `installKittyRowLayers` in `web/terminal-sixel-renderer.mjs`
  replaces ghostty-web's `renderLine` (same three steps, with the
  `tesseraKittyBelow` hook) only on a renderer with ghostty-web's cell
  painters; `kittyLayers`, `drawKitty`, `drawKittySelection`,
  `renderKittyRow`; the overlay path sets the hook around painting.
  `web/terminal-plain-renderer.mjs` calls the same hook.
- During smooth scrolling, the row above the viewport (row -1) is painted
  after the hook is removed, so a behind-text image there is missing for
  those frames. Sixel tiles in that row likely behave the same way, since
  they are also drawn before it is painted (reasoned from the code, not
  tested).
- Still not done: animation.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md` (merged
  with task 293's entry, both unreleased).
