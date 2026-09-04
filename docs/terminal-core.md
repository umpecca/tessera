# Sixel and shared terminal state

Tessera keeps a Ghostty terminal core on the Go host for each running shell.
The browser runs the identical WebAssembly artifact and paints text and image
fragments on the existing canvas. Sixel is enabled by default. Try
`node scripts/sixel-demo.mjs` in a Terminal pane.

## Building the patched core

Ordinary `npm run build:web` and `go build ./cmd/tessera` consume the checked-in
`internal/terminalcore/ghostty-vt.wasm`. They do not need Zig, CGO, or a source
checkout of Ghostty. JavaScript and Go embed the same bytes; their SHA-256 is
the compatibility identifier. The npm dependency is exactly `ghostty-web@0.4.0`.

For core development, install Git, Node 22 or newer, and **Zig 0.15.2**. Set
`ZIG` to the executable path if it is not on PATH, then run:

```sh
npm ci
npm run build:terminal-core
npm run build:web
node --test internal/terminalcore/core.test.mjs web/*.test.mjs
go test ./...
npm run verify:terminal-core
```

The source manifest is `internal/terminalcore/source.json`. The builder checks
out Ghostty Web v0.4.0 at `9e4e126d89ac3537d2b2ebec075849851566de9f` and its
Ghostty submodule at `5714ed07a1012573261b7b7e3ed2add9c1504496`, applies the
upstream WASM patch, then applies `scripts/patch-terminal-core.mjs` and the
tracked Zig extensions in `internal/terminalcore/source/`. Each build gets a
fresh checkout under `.cache/terminal-core`; existing checkouts are untouched.
The verification command compares the rebuilt bytes with the bundled artifact.
CI runs this comparison, regenerates the JavaScript bundle, and runs tests.

Upstream licenses are beside the WASM. Windows additionally embeds Microsoft's
MIT-licensed ConPTY 1.24.260710001 for amd64, arm64, and 386. Older inbox ConPTY
versions consume DCS instead of forwarding it. The redistributable is extracted
to a content-addressed directory under the user's cache and loaded by absolute
path. `internal/winconpty` contains the adapted Go wrapper and licenses.
`scripts/vendor-conpty.ps1` verifies the pinned NuGet archive and refreshes these
assets. Windows release binaries include the assets; no separate installation
is required.

## Protocol and restoration

Protocol 2 attachment metadata includes the protocol, core hash, shell epoch,
event sequence, raw byte offset, canonical geometry, and snapshot length.
An incompatible client is explicitly closed and must reload the matching build.

Binary frames start with a 21-byte header: kind (u8), sequence (little-endian
u64), raw output end offset (u64), and payload length (u32). Kinds are output
(1), geometry (2), live clipboard effect (3), snapshot chunk (4), and color
configuration (5), image settings (6), and clear images (7). Image settings carry
a little-endian u32 budget in MiB and a one-byte placeholder flag; clear images
has no payload. Geometry carries four u32s: columns, rows, cell pixel width,
and cell pixel height. Configuration carries one byte: dark (0) or light (1).

Output, accepted resizes, and configuration events share the session mutex and
sequence. The last accepted browser resize remains canonical. The host parses
PTY output while detached and is the sole writer of parser-generated terminal
replies. Browser keyboard, paste, and mouse input still go to the PTY normally.

The host retains 4 MiB of ordered events. A matching replica resumes when its
**applied** sequence remains retained. Otherwise snapshot capture and live
subscription happen under one lock. Snapshot data travels in chunks of at most
64 KiB, is imported completely, and is followed by queued events. Disconnects
discard unapplied events; partially received parser input already in the core
survives in the snapshot. Clipboard effects are live-only; replay substitutes
empty effect events, and snapshot import emits no replies or clipboard writes.
OSC 52 remains write-only with the existing 1 MiB encoded payload limit.

Snapshots use the `TSS2` schema and require the exact matching core hash. They
include both screens, retained history, cells and image attachments, styles,
palettes, cursor/saved cursor, modes, tab stops, UTF-8/escape/Sixel continuation,
and incomplete OSC input, image settings, and discarded-image markers.
Pointer-bearing structures are reconstructed; page
payloads use native relative offsets, not addresses. Snapshot buffers are
released after transfer/copy. Closing the managed shell releases its module.

A fresh browser can restore images even after their original bytes leave the
replay window. The guarantee covers the running shell's retained screen and
history. It does not cover server restarts, evicted images, or unlimited history.

## Compatibility and resource limits

The terminal context menu offers 16, 32, or 64 MiB image budgets (64 MiB by
default), a **Show discarded image markers** toggle (on by default), and
**Clear terminal images**. These controls apply to the running shell and all
attached browsers, survive reconnects and terminal resets, and do not persist
across server restarts. Lowering the budget immediately discards oldest decoded
images. Raising it does not recover discarded pixels. Markers retain cell
placement and obey normal erasure and scrolling; attachment limits can remove
them. Clearing images removes images and markers from both screens and history
without changing text or cursor position, and safely discards an image currently
being received. The next image can display normally.

The decoder supports RGB/HLS definitions, repetition, raster dimensions,
transparent backgrounds, cancellation, fragmented DCS, and DECSDM scrolling.
Placement follows VT340-style first-column/last-image-row cursor behavior, with
square logical pixels. Historical palette animation and non-square pixel aspect
emulation are intentionally excluded. The practical reference is the
[xterm image addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-image).

Images attach to native cells, so overwrite, erase, insertion/deletion, scroll
regions, reflow, and alternate screens move or remove their fragments with the
text. Font metric changes scale existing cell attachments; device pixel ratio
affects canvas resolution. Decoded browser bitmaps are cached once and released
on eviction, replacement, reset, and disposal. Cursor and scrollbar paint after
images; selection remains visible over selected fragments.

- At most 16,000,000 pixels per image and 32 MiB encoded DCS payload.
- At most 64 MiB of decoded image storage, including construction and growth
  copies. Oldest images are evicted deterministically before allocating.
- At most 262,142 cell fragments; oldest images are also evicted for attachment
  capacity. An image that cannot fit is discarded as a whole.
- Painting is bounded to 1,048,576 pixels per repeat/data command and 64 million
  painted pixels per sequence. Excessive repainting is rejected, and remaining
  bytes are consumed through termination without leaking text.
- The default history is 10,000 lines, additionally bounded by Ghostty's
  64 MiB page budget for unusually wide or heavily styled histories.
- Snapshots are capped at 192 MiB; host WASM address space is capped at 512 MiB
  including parser, pages, render state, allocator overhead, and snapshot copies.

`scripts/benchmark-terminal-core.mjs` compares ordinary text decoding against
the original npm artifact; `BenchmarkCoreTextOutput` measures the Go runtime.
