# Investigate terminal graphics reliability and repair canvas recovery

Status: complete for the investigation and canvas recovery repair. Silent
corruption and intermittent Chrome graphics stalls remain unresolved.

## Request

Research the classic renderer's small pixel corruption and Chrome presentation
stalls, implement evidence-backed repairs or mitigations, and validate them
against saved builds with visible browser controls.

## Requirements

- Preserve classic/experimental text, Unicode, fractional scaling, selection,
  links, images, partial paints, and overlapping terminal windows.
- Compare candidate canvas backing strategies with the unchanged baseline;
  measure painting/output behavior before selecting a product change.
- Preserve the page initialization repair and matching host/browser cores.
- Add meaningful graphics recovery tests where deterministic coverage is
  possible; do not weaken pixel validation to accept corruption.
- Run the full checks and sustained visible output/pixel validation. Report
  any remaining browser/driver limitation without claiming universal repair.
- Keep the live server and product-wide graphics settings untouched. Do not
  tag, publish, or commit as part of this task.

## Validation

- Added context-loss guards and full text/image recovery for both renderers.
- Real test-browser GPU-process restarts passed for classic and experimental
  renderers, preserving native handles and output written during the outage.
- Final 513 JavaScript tests, Go tests/vet/build, packaged 125%/150% DPI smoke
  checks, and 24 exact visible pixel checks passed.
- Final saved-build/recovery-build load controls drained all output and showed
  similar echo latency; real test-browser GPU-process recovery passed twice.
- Tested three canvas backing candidates, a ten-minute visible CPU candidate
  soak, and alternating untraced load controls. CPU backing produced clean
  pixels but doubled p95 echo delay and retained stalls, so it was removed.
- Native page initialization repair and core identity remain unchanged.
- See `docs/terminal-graphics-reliability-2026-10-05.md` for measurements, source
  research, reproducible controls, and explicit remaining release limitations.
