# Known issues

The terminal graphics issues below remain open. Last investigated:
**2026-10-05**. The tested environment was Windows, Chrome 154.0.8037.95,
Intel UHD 630, Intel driver 31.0.101.2134, and ANGLE D3D11. The evidence does
not establish that every Windows system or Chromium browser is affected.

## Terminal graphics stalls on Windows

**Status: unresolved; intermittent.** Both the **Stable** (classic) and
**Experimental** terminal renderers have shown occasional delayed painting
and keyboard echo during sustained output, despite responsive typical latency.
Measured outliers reached roughly 0.3–0.5 seconds across the saved build and
diagnostic candidates. The measured terminal runs eventually drained all output.

Captured Chrome GPU-thread events include long Windows presentation and
command-buffer intervals with much less CPU time than wall time. A native
graphics/synchronization wait or Windows descheduling is consistent with this;
the exact cause is unconfirmed. Switching terminal renderers does not reliably
avoid the symptom.

A plain Canvas2D fixture also reproduced the long presentation path, but its
large outliers occurred with GPU device timing enabled. Untraced and less
intrusive trace controls did not repeat those isolated outliers. Earlier
untraced Tessera runs did show stalls, so the terminal symptom cannot be
dismissed as profiling overhead. Profiled failure frequency should not be
treated as the normal-user failure rate.

There is no validated general workaround. CPU-backed canvases retained stalls
and worsened p95 echo latency in paired tests, so Tessera preserves its normal
canvas allocation policy. Browser graphics switches used in diagnostic
controls have not been adopted as product defaults.

See the [graphics reliability investigation](terminal-graphics-reliability-2026-10-05.md)
and [browser-only isolation results](terminal-graphics-isolation-2026-10-05.md)
for measurements, controls, and the native wait-stack evidence still needed.

## Rare terminal canvas corruption

**Status: unresolved; observed once in an automated Stable renderer check.**
A full-paint check captured 30 unexpectedly colored, translucent pixels in an
8×4 region. Both canvas readback and the exported PNG contain the same damage.
The affected region was below the test's visible viewport; visible on-screen
corruption has not been confirmed.

The severe damage did not repeat in 64 standalone pixel checks. Separate
one-level grayscale differences after accelerated-canvas readback are
repeatable browser behavior and are recorded independently. They do not
explain the original colored/translucent pixels.

The cause and a reliable prevention are unconfirmed. There is no evidence yet
that selecting another renderer, a different graphics backend, or CPU canvases
generally repairs this issue. An occurrence needs raw canvas pixels and an
independent compositor capture of the affected region before repainting.
See the [pixel investigation](terminal-graphics-isolation-2026-10-05.md#reassessing-the-original-pixel-corruption).

## Recovery and reporting

Both renderers automatically rebuild their drawing state, image bitmaps, and
retained content after a reported canvas context loss. This recovery is
implemented and tested; it does not repair an unreported corrupt bitmap or
unblock a waiting graphics thread. The previously identified native page-memory
initialization crashes have also been repaired and are separate from these
open graphics issues.

If a visual problem appears, record the browser/OS versions, GPU and driver,
selected renderer, display scaling, workload, and whether the problem was
visible on screen or only in a canvas export. **Settings → Diagnostics → Copy
diagnostics** provides Tessera's rendering and connection summary without
workspace or clipboard contents. A screenshot or recording of a visible
occurrence helps distinguish it from readback-only damage.

Reloading the browser page restores terminal content from the running host
without ending the shell. It can reconstruct the view, but is not a validated
prevention for either issue. Switching renderers or changing graphics settings
should be recorded as a diagnostic comparison, not assumed to be a fix.
