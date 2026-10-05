# Fix reused native terminal page initialization

Status: complete. Native crash fixed; overall visual release validation failed.

## Request

Apply the approved fix for the crash found by task 154, add a same-instance
terminal lifecycle regression, rebuild the host/browser cores, and validate
with the complete tests, performance measurements, and a longer visible soak.

## Requirements

- Initialize initial and growing terminal page buffers before interpreting
  their cell contents, including pooled allocations recycled by WASM.
- Preserve image attachments, Unicode/graphemes, history, reflow, snapshots,
  ordinary output throughput, and incremental rendering behavior.
- Demonstrate the regression fails with the saved old core and passes with the
  rebuilt core; exercise terminal disposal and reuse in a shared WASM instance.
- Rebuild and independently verify the pinned native artifact and browser
  bundle together. Run the full regression suite and 10-minute visible soak.
- Preserve the running server and user sessions. Leave changes uncommitted;
  do not tag or publish as part of this task.

## Validation

- Initial and growing page buffers now clear before initialization, including
  freshly allocated pooled pages and capacity beyond a former page layout.
- The same-instance regression fails on the saved old core (a new cell contains
  codepoint 48,538 instead of zero), then passes on the rebuilt core. It covers
  160 terminal creations/disposals, images, Unicode/graphemes, and snapshots.
- Passed all 512 JavaScript tests, the Go suite with the existing ephemeral-port
  overlay, Go vet, six Zig decoder tests, and the Windows executable build.
- Fresh pinned-source verification reproduced the WASM exactly; a second web
  build reproduced the browser bundle. Packaged checks passed at 125% and 150%
  scaling, including typing/reload and matching host/browser core attachments.
- Five paired parser runs measured ordinary build throughput 2.2% lower and
  Unicode 1.7% lower; tiny progress writes were 2.4% faster by time. Lifecycle
  memory stayed at 43.125 MiB; retained-image tiny writes remained ~0.224 µs.
- Completed the 10-minute visible hardware soak: 2.23 GiB / 9,921 echoes, all
  drained. No native traps; all six formerly crashing image/Unicode cases passed.
- The hardware run exited nonzero for a separate 30-pixel classic-canvas
  corruption (23/24 checks passed). One delayed frame affected four echoes,
  worst 311.6 ms; trace shows a 360 ms GPU DXGI presentation block before capture.
- The short visible software control passed all 24 exact pixel checks and
  lifecycle checks. Product graphics settings and the live host were untouched.
- Report: `docs/terminal-page-initialization-2026-10-05.md`. Hold tagging while
  the hardware presentation/canvas issues remain unresolved. No tag or commit.
