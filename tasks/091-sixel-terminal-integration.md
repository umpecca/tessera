# Task 091: Sixel terminal integration

Status: implemented; native macOS release verification pending CI

Implement the user-approved Sixel plan while retaining Ghostty. The shared,
pinned WASM core owns decoding, buffer-attached images, terminal replies, and
logical snapshots. A Go host replica maintains running-session state for
restoration in any browser, independently of the bounded raw-output replay.

## Requirements

- Reproducible Ghostty Web 0.4.0 / Zig 0.15.2 source build and bundled artifacts.
- Streaming, bounded Sixel decoding, native image placement and buffer mutations.
- Canvas rendering integrated with the existing scheduling and terminal features.
- Versioned logical snapshots including partial parser state and both screens.
- Host-owned replies and ordered output/geometry events; browser resume after
  application, snapshot fallback, live-only clipboard effects.
- Restore retained images after the original bytes leave the 4 MiB replay buffer.
- Keep 10,000 history lines and a 64 MiB decoded-image budget per terminal.
- No server-restart persistence or unlimited image history.

## Verification

Native decoder and buffer tests; host/browser state parity and snapshot tests;
fragmentation, cancellation, resource limits, scrolling, erasure, resizing,
alternate screens, reconnect ordering, query ownership, and clipboard effects.
Run existing frontend and Go tests, browser visual checks, and release builds.

## Implementation notes

The user explicitly approved the complete plan and requested implementation;
that approval satisfies the develop-code skill's task confirmation step.

The implementation includes the native streaming decoder and cell attachments,
wazero host state, protocol 2 snapshots/events, browser image rendering, live
clipboard effects, canonical geometry/colors, and pinned build tooling. Windows
bundles Microsoft's modern ConPTY because the inbox version dropped Sixel DCS.

Verified locally:

- Zig decoder tests; native WASM fragmentation, cancellation, palette,
  transparency, input/work/storage limits, cursor/origin mode, mutations,
  scrolling, alternate screens, reflow, and snapshot continuation.
- Wazero-to-JavaScript restoration, ordered snapshot/live events, replay
  eviction, applied resume watermarks, one reply with two subscribers, and
  live-only clipboard effects.
- Browser image output, reload after 4.4 MiB of later output, and a second
  browser restoring the image and surrounding text. Renderer tests cover
  scaling, cache cleanup, DPI-independent placement, and drawing order;
  existing scheduler tests cover hidden panes and multiple terminals.
- Full Go suite and 186 JavaScript tests; Windows amd64 and Linux amd64/arm64
  release builds. Terminal packages cross-compile for macOS arm64. The full
  macOS binary needs the existing CGO system tray dependency on a native runner;
  the added CI matrix provides that gate.
- Independent pinned source checkouts produce identical bundled WASM bytes.

Text-only benchmark on this Windows host: upstream/current rewrite throughput
48.7/49.8 MB/s and scrolling throughput 47.6/43.9 MB/s. Wazero host throughput
was 15.7 MB/s. These are local measurements, not cross-platform guarantees.

The resource documentation records bounded attachment count and painting work
in addition to the planned image/input/storage limits. No migration or restart
persistence was added.
