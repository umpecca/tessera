# Task 200: Mosaic screensaver

Status: complete

## Request

A screensaver to show off, started by hand from the command palette for
now. It doesn't lock the workspace.

## Changes

- `web/screensaver.mjs`: `MosaicScreensaver`, a full-screen canvas of square
  tiles (tesserae) colored by slow interfering waves. Every few seconds a
  ripple crosses the field. The palette moves through lapis, ember,
  verdigris and amethyst, holding each for 47 seconds. The time is set in
  lit gold tiles on a dark plate with the date beneath, using the locale's
  12- or 24-hour clock. The clock drifts one tile every few seconds so
  nothing stays lit in place on OLED screens. When the minute changes, a
  ripple spreads from the clock.
  - Rendering: tile colors are computed at one pixel per tile into an
    `ImageData`, scaled up without smoothing, and covered with a grout and
    bevel layer drawn once per size. The glow is the lit tiles scaled up
    with smoothing and composited with `lighter`. Each frame is one small
    `putImageData` and a few `drawImage`s, with no per-tile canvas calls
    and no `ctx.filter` (unsupported in older Safari). Tiles are a whole
    number of device pixels, so seams stay even at any pixel ratio.
  - Exit: any key, click, tap, wheel or mouse movement of 14px or more.
    Input in the first 450ms is ignored, so the Enter or click that ran the
    palette command doesn't close it. Keys are swallowed in the capture
    phase and never reach a terminal. The overlay keeps covering the page
    while it fades out, so the pointerup and click from a dismissing tap
    don't land on a window underneath.
  - With reduced motion it runs at 30% speed, with no ripples and no
    radial reveal.
  - Closing releases the full-screen canvases.
- `web/app.js`: **Screensaver** palette command (aliases `screen saver` and
  `mosaic`). It has no two-letter code, so it can't collide with codes that
  user shortcuts already use, and adding one would mean changing
  `internal/shortcuts.ReservedCodes`. The screensaver is listed among the
  overlays that block window shortcuts and that keep focus when another
  overlay closes. Focus returns to the active pane when it closes.
- `web/styles.css`: the `.screensaver` overlay, above everything else.
- README: workspace behavior entry.

## Validation

- `web/screensaver.test.mjs`: glyph shapes, 12- and 24-hour text, layout
  widths, grid coverage and whole-pixel tiles at several screen sizes, clock
  fit and drift bounds, palette hold and blend, gradient interpolation, and
  the dismissal grace period and jitter threshold. Full JavaScript suite
  passes (604).
- Headless Chrome at 1440×900 and at 820×1180 @2x (iPad portrait):
  screenshots checked for the reveal, all four palettes, the clock plate,
  the date and a ripple.
- Against a scratch server (`-web web`) in headless Chrome over CDP:
  `Ctrl+K`, typing `screensaver` and pressing Enter opens it with focus on
  the overlay; a key inside the grace period is ignored; the next key
  closes it. No console errors.
- Not run in Safari or on an iPad.
