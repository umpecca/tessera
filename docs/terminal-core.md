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

Tessera's browser adapter measures full font ascent and descent, including
regular and bold accented letters and descenders. Older browsers without font
bounding-box metrics use measured glyph bounds. The same metrics position text
and cursors and determine selection, mouse coordinates, terminal fitting, and
Sixel cell geometry. These rows are taller than Ghostty Web's capital-M-only
measurements, which placed text too high and could clip accents.

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
event sequence, raw byte offset, canonical geometry, snapshot length, and the
host's retained event-window budget (`retainedOutputBytes`).
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

Each host core lazily reuses its WASM input and response scratch buffers. Normal
PTY reads retain an 8 KiB input region and a shared 4 KiB region for query and
clipboard drains. Input capacity doubles as needed up to 64 KiB; larger direct
writes allocate temporary input space and free it after the write. Every access
uses current module memory, and drained results are copied into owned Go bytes.
Closing the core frees both retained regions before releasing the terminal and
module. This removes per-read allocation/free calls while retaining at most
68 KiB of scratch space per used host core.

The host retains 4 MiB of ordered events. Browser resumes send `catchUpReplay=1`
with their **applied** cursor and replay at most 64 KiB and 128 events. Both
limits include all event kinds; byte counts include headers and the sanitized
empty clipboard events actually sent. A missing, mismatched, evicted, or larger
gap uses a current snapshot. Older clients retain their existing replay policy.
Snapshot capture or replay selection and live
subscription happen under one lock. Snapshot data travels in chunks of at most
64 KiB, is imported completely, and is followed by queued events. Disconnects
discard unapplied events; partially received parser input already in the core
survives in the snapshot. Clipboard effects are live-only; replay substitutes
empty effect events, and snapshot import emits no replies or clipboard writes.

The browser also bounds **unapplied output bytes** per terminal. Settings →
Advanced → Performance → Terminal output backlog offers Auto (the attachment's
retained-event budget, normally 4 MiB) and 8/16/32 MiB overrides. Older hosts
that omit the budget use a 4 MiB Auto fallback. The preference lives in browser
storage, applies to open replicas immediately, and does not change the host's
history or image budgets. Snapshots and configuration events do not consume
the output backlog budget.

All browser terminal write queues share one coordinator. The active visible
terminal receives three complete events per visit; other ready panes receive
one. Each turn yields after 64 KiB of output or approximately 5 ms of work,
whichever is reached first, checking the limits between every event. A visit's
remaining quota survives yields so costly active events cannot starve siblings.
Focus changes promote the new active pane immediately. Fresh active output can
move ahead of queued builds once, then a background pane must progress before
another promotion. Idle active panes reserve no capacity, and hidden or
unselected panes receive no priority. Live replica
tasks pass their output-byte count to the scheduler; resize, configuration,
clipboard, image controls, and snapshot imports consume time without charging
the output-byte budget. Each pane retains its own FIFO and applied cursor.

The coordinator posts `MessageChannel` tasks to avoid nested `setTimeout(0)`
throttling during sustained output, with a timer fallback when unavailable.
Canceling a queue removes only that pane, and canceled posted messages cannot
run a replacement stream. Hiding, disconnect, recovery, and disposal release
pending work without stopping sibling terminals. Limits are cooperative between
atomic events: a large event or snapshot import can exceed a turn's budget,
then yields before another event. Parser failures cannot strand sibling queues.

Terminal painting uses a separate shared budget of approximately 6 ms per
animation frame, checked between complete terminal paints. The active visible
pane paints first, and completed panes rotate behind other ready panes. If an
active paint consumes the frame without background progress, the next frame
starts with a waiting background pane. Idle panes reserve no capacity.

Deferred redraw requests remain queued and paint the latest core state; no
intermediate screen copies accumulate. FPS deadlines advance only when a pane
actually paints, and typing still bypasses FPS caps and output coalescing.
Pausing or disposing a pane removes its pending paint and priority. A single
large paint can exceed the cooperative budget before the scheduler yields.
The single-ready-pane path needs no extra budget clock reads, and painting
failures leave sibling redraws scheduled.

On overflow the replica discards unapplied events, stops accepting that socket's
remaining messages, and leaves its applied cursor unchanged. It reconnects to
the same running shell without a resume cursor to request a fresh authoritative
snapshot. This also prevents replaying the same oversized backlog after the
user lowers the limit. The snapshot request survives disconnects and is cleared
only after a complete snapshot import; later events apply in order. Pending
output is released as it is applied or discarded. Recovery uses a separate
exponential backoff from 500 ms to 10 seconds, reset after 30 seconds without
an overflow, so successful socket opens cannot cause rapid repeated retries.
OSC 52 remains write-only with the existing 1 MiB encoded payload limit.

Browser terminal writes discard local query responses and clipboard data because
the host owns those effects. Clipboard draining reuses a lazily allocated 4 KiB
WASM scratch region per terminal. The module owns its pointer, which remains
valid through terminal resets, snapshot handle replacement, and memory growth.
Disposal releases the scratch region before native terminal cleanup; no typed
memory view is retained across writes.

Minimized panes, fully covered panes, and hidden documents suspend browser
parsing as well as painting. A visibility transition synchronously discards
pending events and partial snapshot buffers without advancing the applied
cursor, then ignores incoming attachment and output messages. The WebSocket
stays open for shell-exit and failure close frames; the host continues parsing
and retaining terminal state. A `pause-output` control message drops that
attachment's queued output and stops future enqueueing. Its acknowledgement,
`output-paused`, is serialized with socket writes; no output or timing frames
follow it. Frames already in flight are discarded by the hidden replica.
Other attached clients keep receiving output and live clipboard effects.
Initially hidden connections request `outputPaused=1`, skip snapshot/replay
construction and transfer, and retain only lifecycle delivery.

Revealing a pane replaces that socket and supplies its fully applied cursor.
The host resumes unchanged state without replacing the view, replays a small
missing suffix, or sends a fresh snapshot for larger gaps and invalid cursors.
Replay includes geometry, color, and image controls even when the output byte
offset is unchanged. Dropped queued or in-flight events remain eligible for
replay because they never advanced the applied cursor. The browser requests
bounded replay on every resume, including connection retries after a partially
applied replay. It also sends `snapshotIfChanged=1` on visibility resumes so
the preceding host build keeps its snapshot-on-change fallback.

Snapshot selection marks the replica as requiring a fresh snapshot until the
import completes. Hiding or disconnecting while chunks are incomplete, or
after receiving them but before the queued import, keeps that requirement.
Backlog recovery also omits the resume cursor to force a fresh snapshot. A
snapshot imports before subsequent live events; replays apply in order under
the shared parsing budget. Live-only clipboard effects from the hidden interval
are not replayed. Idle panes preserve selection and scroll position. Changed
terminals follow their normal output and scrolling behavior. Old socket callbacks
cannot change the replacement
replica or close its pane. Network retries and wake recovery skip hidden panes;
visibility resumes recoverable connections while permanent exit and core
compatibility failures remain settled.

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

Image cleanup checks page membership before scanning cells, so retained images
do not make every output write scan text-only history. Placement and copies
mark destination pages; reflow conservatively marks its pages for one cleanup
pass. Membership is a derived cache rebuilt during snapshot import and does
not change the snapshot schema. Erasure and history eviction still reclaim
unreferenced image pixels and fragments at the end of the write.

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
the original npm artifact and measures tiny writes with one retained image at
different history sizes. Use `--retained-images-only` for just those cases and
`--compare=<wasm path>` to compare a saved core in the same process.
`BenchmarkCoreTextOutput` and `BenchmarkCoreSmallWritesWithRetainedImage`
measure the Go runtime.
