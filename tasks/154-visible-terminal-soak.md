# Longer visible-browser terminal soak

Status: complete. Test result: failed release validation.

Follow-up: task 155 fixed the native crash. Its longer hardware rerun still
failed on graphics presentation/canvas issues; see the task 155 report.

Run a sustained visible Chrome test of the current release candidate, using
large overlapping panes and heavier output. Measure echo latency and queue
drain, monitor browser errors and rendering checks, and capture graphics traces
around stalls. Preserve the running server and all user sessions. Report what
reproduces and what remains uncertain, without changing product graphics defaults.

## Validation

- Ran 10 minutes of visible Chrome output with default Intel/ANGLE D3D11 GPU
  rendering: four large experimental panes for four minutes, four large classic
  panes for three minutes, and eight ordinary panes at 8 MiB/s for three minutes.
- Processed ~2.23 GiB and all 9,610 echo probes. All queues drained. Worst echo
  was 57.1 ms; the prior 400–487 ms graphics stall did not reproduce.
- The following 160-terminal creation/disposal exercise passed. The fourth
  rendering check (image plus Unicode) then hit a native WASM memory trap.
  The independent short setup run reproduced the same failure and stack.
- Captured a 17.4 MB trace around the native failure. Twenty following checks
  failed in the shared instance after that initial crash; these are follow-on
  failures, not 21 independent defects.
- Added reusable visible-soak and variable-duration load diagnostics without
  changing product code, rebuilding artifacts, or restarting the live server.
- Report: `docs/terminal-visible-soak-2026-10-05.md`. Native crash blocks tagging;
  underlying cause remains to be isolated and fixed.
