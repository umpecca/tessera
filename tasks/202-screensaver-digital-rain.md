# Task 202: Matrix-style digital rain in the screensaver

Status: complete

## Request

Give the screensaver (task 200) some influences from the Matrix films. A
typed "Wake up, Neo..." intro was planned, then dropped at the user's
request as too cheesy.

## Changes

- `web/screensaver.mjs`:
  - `DigitalRain`: up to three falling streams per column. Each step writes
    a per-tile trail intensity (1 at the head, fading behind it) and marks
    head tiles. A new stream starts only after the newest one has cleared
    the top edge.
  - Rain glyphs are half-width katakana, digits and a few symbols, drawn
    mirrored from a white atlas built once per tile size. Trail glyphs go
    onto one full-size layer, which is tinted with a single `source-in`
    fill and added to the frame. Heads are added in white, and the glow
    layer adds a haze along the trails. Glyphs change at random as they
    fall. Tiles under rain are darkened toward near-black green so the
    glyphs read as carved into the mosaic. Rain stays off the clock plate.
  - Palettes are now objects with `rain` (density), `field` (wave
    brightness), `trail` (glyph color) and `lit` (clock tile colors). A new
    green **phosphor** palette has full-density rain, a dim field and a
    pale-green clock. The others have light rain in their own colors and the
    gold clock. The date takes the clock's light color.
  - Opening reveal: each column gets one fast stream at a speed
    proportional to screen height, which paints the mosaic in from the top
    in about two seconds at any size. This replaces the radial reveal.
  - Déjà-vu glitch: every 18–43 seconds, for about a third of a second, a
    band of 2–6 tile rows repeats just below itself, shifted 1–4 tiles
    sideways, flickering.
  - Reduced motion: no rain or glitches, and the mosaic fades in as before.

## Validation

- `web/screensaver.test.mjs`: palette hold and blend for every field; the
  phosphor palette has the densest rain; glyphs are single characters;
  trail intensity peaks at the head and fades behind it; the opening pour
  reaches the bottom of every column in under 2.2 seconds; dense rain
  covers more tiles than sparse rain; at most three streams per column.
  Full JavaScript suite passes (608).
- Headless Chrome (GPU) at 1440×900 over CDP: render takes a median of
  0.7–1.1 ms on the main thread (p95 1.0–1.6 ms, max 4.7 ms) during
  phosphor and lapis, at about 70 frames per second. Screenshots checked
  for phosphor rain, light rain in lapis, the plate and the date. Software
  rendering (`--disable-gpu` with a virtual time budget) took several
  minutes per screenshot, so check frame rate on real hardware.
- Not run in Safari or on an iPad.
