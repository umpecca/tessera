# Isolate intermittent terminal corruption and graphics stalls

Status: investigation recorded. Exact native wait and severe pixel-corruption
root causes remain open; no product mitigation selected.

## Request

Find out what causes the remaining intermittent pixel corruption and graphics
stalls after the native page initialization and canvas recovery repairs.

## Work

- Inspect the original corruption and graphics traces, including nested GPU
  work, context attributes, and whether the damaged pixels were visible.
- Reproduce Canvas2D drawing without terminal parsing or application scheduling.
- Compare isolated browser graphics controls, preserving normal product policy.
- Save reproducible diagnostics and distinguish observations from hypotheses.
- Keep the live server, user sessions, installed drivers, and release tag intact.

## Validation

- Inspected original traces and separated GPU-thread CPU time from wall time.
- Located the original corrupt region below the visible test viewport.
- Independently decoded the original PNGs and confirmed the same 30 corrupt
  RGBA pixels, ruling out a hash comparison or single ImageData-array error.
- Added a terminal-free Canvas2D reproduction and independent opaque/grayscale
  invariants, with raw RGBA and compositor failure capture.
- Ran ten 90 s visible load controls (15 minutes) and 64 pixel checks, comparing
  hardware, selective GPU controls, software, WARP, and two trace strategies.
- Reproduced long Windows presentation in the device-profiled standalone page;
  untraced/service-profiled controls did not repeat the large isolated stalls.
  Original untraced Tessera stalls remain valid and unexplained at native level.
- Severe corruption did not repeat; one-level grayscale readback differences
  remain separate from the original colored/translucent corruption.
- Product bundle/core hashes and live terminal sessions remain unchanged.
- Measurements, research, reproduction instructions, and remaining boundaries:
  `docs/terminal-graphics-isolation-2026-10-05.md`.
