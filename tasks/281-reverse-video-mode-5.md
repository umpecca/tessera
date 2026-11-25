# Task 281: Reverse video (DECSCNM, mode 5)

Status: implemented, awaiting a visual check in a browser (2026-11-24).

## Request

Item #2 from the mode review after task 279: a program that sets reverse
video (`CSI ? 5 h`), as visual bells do (vim `set visualbell`, readline
`bell-style visible`, terminfo `flash`), sees no change. The user said
"lets do #2 next".

## Findings

- The core already handles mode 5: with it set, cells come out of the render
  state with the default foreground and background swapped, and inverse
  cells swap back (checked against `internal/terminalcore/ghostty-vt.wasm`).
- The browser paints row backgrounds, the pane, the cursor and the selection
  from `renderer.theme`, which never changes with mode 5.
- ghostty-web's renderer (and Tessera's plain-row fast path) skip any cell
  background that is exactly black, assuming black is the default. In light
  mode that already hides inverse text today: an SGR 7 cell gets a black
  background that is not painted, under white text, on a white row (reproduced
  with ghostty-web's `CanvasRenderer`). Reverse video in dark mode hits the
  same rule for inverse cells, so the fix needs it.

## Scope

- While mode 5 is set, the pane's theme swaps foreground and background
  wherever they appear (also the cursor, cursor text and selection colours
  that follow them); colours a program set to something else stay.
  Program colours (OSC 10/11) are applied first, then swapped, as the core does.
- A cell background is skipped only when it equals the theme background, not
  whenever it is black; in ghostty-web's `renderCellBackground` (via a
  Tessera renderer patch) and in the plain-row fast path.
- Out of scope: cursor shape/blink (item #3), other modes.
- Approval: the user chose item #2 ("lets do #2 next"). The black-background
  fix goes beyond that request: it is needed for inverse cells under reverse
  video, and it also fixes light-mode inverse text and explicit black
  backgrounds. Flagged to the user.

## Acceptance criteria

- [x] `CSI ? 5 h` swaps the pane's background, text default, cursor and
      selection colours; `CSI ? 5 l` restores them, also after a snapshot.
- [x] Program-set colours are swapped consistently with the core's cells.
- [x] Light mode: an inverse cell paints a black background; explicit black
      backgrounds paint.
- [x] Dark mode: cells on the default black background are still not
      repainted (no extra fills).
- [x] Docs and CHANGELOG updated.

## Verification

- `node --test web/terminal-cell-backgrounds.test.mjs web/terminal-colors.test.mjs web/terminal-entry.test.mjs web/terminal-plain-renderer.test.mjs`:
  61/61 pass. New: light-mode inverse and SGR 40 paint black; dark mode
  skips default black; reverse-video inverse cells; selection and wide
  cells; theme-key cache; plain-row fast path on a light theme; theme swap
  rules; a real-core test (`ghostty-vt.wasm`) of `CSI ? 5 h`/`l`, OSC 11 then
  mode 5, and mode 5 surviving a snapshot restore.
- `node --test web/*.test.mjs`: 1085/1085 pass.
- `npm run build:web`: succeeded; the patch is in `web/vendor/terminal.js`.
- Before the change, a scratch script with ghostty-web's real
  `CanvasRenderer.renderCellBackground`/`renderCellText` showed a light-mode
  SGR 7 cell paint no background and white text.
- All checks are automated, with mocked canvases. Not checked visually in a
  browser (pending, user): `printf '\e[?5h'; sleep 1; printf '\e[?5l'` in
  both themes, and vim's status line in light mode.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: `printf '\e[?5h'` swapped the theme (light background, dark text), inverse cells swapped back; `\e[?5l` restored.

## Implementation notes

- `web/terminal-colors.mjs`: `terminalThemeInReverseVideo`.
- `web/terminal-entry.js`: `syncColors` also re-runs when mode 5 changes
  (`getMode(5)` per write) and swaps the program-coloured theme.
- `web/terminal-cell-backgrounds.mjs` (new): replaces ghostty-web's
  `renderCellBackground`, installed before search highlights, which wrap it;
  `terminalThemeBackgroundKey` is shared with
  `web/terminal-plain-renderer.mjs`.
- A visual bell sent as `?5h` and `?5l` in one PTY read shows no flash,
  since only the final state is painted. Terminfo `flash` delays between
  them, so they normally arrive separately.
- Docs: `docs/terminal.md`; `CHANGELOG.md`.
