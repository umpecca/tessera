# Task 293: Kitty graphics protocol

Status: implemented (first version), awaiting a check in a browser (2026-11-24).

## Request

The user asked about the Kitty graphics protocol, the last sweep item, and
then for an investigation of whether Ghostty's own implementation can run in
Tessera's WebAssembly core.

## Findings (trial build in the session scratchpad; the repository is unchanged)

- The pinned Ghostty source has the full implementation in
  `src/terminal/kitty/graphics*.zig` (about 5,500 lines: commands, storage,
  placements, zlib, PNG via wuffs, Unicode placeholders, render placements).
  It is compiled out because `src/terminal/build_options.zig` ties
  `kitty_graphics` to `oniguruma`, which the lib-vt build turns off; the
  comment there says the link "may be outdated". Tessera's response handler
  also drops every APC string (`.apc_start/.apc_put/.apc_end => {}`).
- Trial changes that made it build for `wasm32-freestanding` and work:
  1. `kitty_graphics` forced on in `build_options.zig`.
  2. APC wiring in `src/terminal/c/terminal.zig`, as Ghostty's
     `termio/stream_handler.zig` does it: an `apc.Handler`, and on
     `apc_end` `terminal.kittyGraphics(alloc, cmd)` with the response encoded
     into the response buffer.
  3. File, temporary-file and shared-memory transmission rejected on
     freestanding (`error.InvalidData`); the browser has no file system, and the
     host should not read files for a program anyway.
  4. `std.time.Instant` (no clock on freestanding) replaced by a transmission
     counter for `transmit_time` and eviction order.
  5. wuffs (PNG) built as a module without libc: the upstream
     `wuffs-v0.4.c`, Ghostty's `pkg/wuffs/src` wrapper, stand-in `string.h` /
     `stdlib.h`, and a shim C file with `strcmp` and a `calloc` that always
     fails (Ghostty's wrapper allocates wuffs' structs with Zig's allocator).
     Nothing else from libc was needed; Zig's compiler-rt provides memcpy and
     friends.
- Result: the core still imports only `env.log`; it grows from 561 KB to
  731 KB (622 KB without PNG). Against it: query (`a=q`) `OK`; transmit and
  display RGBA (`a=T`) `OK`, cursor moved past the image; zlib RGB (`o=z`)
  `OK`; place by id (`a=p`) `OK`; chunked (`m=1`) `OK`; a real PNG `OK`;
  invalid PNG and the file medium `EINVAL`; delete (`a=d`) quiet.

## Work remaining for a real implementation

- Patch steps in `scripts/patch-terminal-core.mjs` and build changes in
  `scripts/build-terminal-core.mjs` for the five trial changes (the wuffs
  tarball is a pinned Ghostty dependency, fetched by `zig build`).
- Limits: set the storage limit (Ghostty's default is 320 MB) to Tessera's
  image memory setting (16/32/64 MiB), per terminal, in both the host and the
  browser cores; the host keeps every session's images too.
- Snapshots: carry images (decoded pixels) and placements (pins as
  positions, virtual placements) so reconnects keep them; the format changes
  (TSS5).
- Exports for the browser: visible placements per frame (Ghostty's
  `graphics_render.Placement`: top-left cell, pixel offsets, source rect,
  destination size, z), image pixels by id (like `tessera_sixel_image_pixels`),
  and Unicode placeholder placements (`graphics_unicode.zig`).
- Browser drawing: per-image bitmaps, placements over text, and below text for
  negative z (harder with row-by-row rendering), scrolling with the text,
  deletion, and the dirty-row rules the Sixel renderer follows.
- Out of scope at first: animation, file/shared-memory transmission.

## Scope of this first version

- Core: Ghostty's implementation with the five trial changes, as patch steps
  and build changes; the storage limit follows Tessera's image memory setting
  per screen; Clear images also clears Kitty images; snapshots carry images
  and placements (snapshot format TSS5).
- Exports: visible placements for a viewport (normal placements with z >= 0,
  and Unicode placeholder placements, which cover only placeholder cells), and
  image pixels by id with a generation for caching.
- Browser: placements drawn whole in front of text by the existing image
  overlay in `web/terminal-sixel-renderer.mjs`, inside its repainted-row clip;
  a changed placement list repaints the pane; scaled from the host's cell size
  to the local one; placeholder characters drawn as nothing.
- Not in this version: images behind text (z < 0, not drawn), animation,
  file / temporary-file / shared-memory transmission (refused), selection
  highlight over images.
- Approval: the user said "go ahead with the first version, in front of text
  only", after the first version was described as images in front of text
  plus Unicode placeholders.

## Approval

- Approved for the first version above.

## Verification

- `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`: core
  `a397ac2825d049c85d8156d36de89abb102199405e571e6108233b8a73516c3f`
  (742,966 bytes, was 561,370); `--check` matches. `zig build` fetches the
  pinned wuffs tarball from Ghostty's dependency mirror on first build.
- `node --test internal/terminalcore/core.test.mjs`: 63/63, three new Kitty
  tests: query, transmit/place, placement records (position, scaling to host
  cells, offsets, z, z < 0 skipped), scrolling with history, bad PNG and the
  file medium refused; zlib RGB, a real PNG (`internal/terminalcore/testdata/kitty-2x3.png`),
  Unicode placeholders, Clear images, the 16 MiB limit evicting the oldest;
  snapshots (TSS5) of both screens, newer generations after a restore,
  deletion.
- `go test ./internal/terminalcore/ -run Kitty`: new
  `TestNativeCoreKittyGraphics`: through the Go/wazero host core the program
  gets `OK` for the query and a PNG, `EINVAL` for a file, and the decoded
  pixels are in the snapshot.
- `node --test web/terminal-sixel-renderer.test.mjs`: 24/24, three new:
  repaint decisions against the real core (new, moved, deleted, scrolled
  away and back; text-only frames stay dirty-row and redraw images inside the
  repainted row's clip); drawing against the real core (z order, scaling from
  host 10x20 to local 5x10 cells, offsets, RGB to RGBA, bitmap cache,
  re-decode after replacement, release after deletion, nothing on frames with
  no repainted rows); placeholder characters not drawn.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1171/1171.
- `go test ./...`: pass. `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`: clean.
- `npm run build:web`: succeeded; `tessera_kitty_placements` in `web/vendor/terminal.js`.
- Text throughput with Kitty compiled in (trial core, 19 MB of coloured
  scrolling output, five runs): 171 ms vs 172 ms, unchanged.
- Not checked in a real browser (pending, user): `kitten icat`, yazi, a
  Unicode-placeholder tool, reconnecting with images on screen, Retina and
  fractional scaling.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: z 0 placement covered text (raw RGBA, chunked, `C=1`); images moved into scrollback with their rows and redrew when scrolled back; a 5 MiB APC string was ignored and the following text printed.

## Implementation notes

- New: `internal/terminalcore/source/kitty_api.zig`,
  `internal/terminalcore/source/wuffs_libc/{string.h,stdlib.h,shim.c}`,
  `internal/terminalcore/testdata/kitty-2x3.png`.
- `scripts/patch-terminal-core.mjs`: final Kitty step (build option, wuffs
  module in `src/build/GhosttyZig.zig`, APC wiring and per-screen limit in
  `src/terminal/c/terminal.zig`, freestanding media refusal and transmission
  counter in `src/terminal/kitty/graphics_image.zig` and
  `graphics_storage.zig`, exports in `src/lib_vt.zig`).
- `internal/terminalcore/source/snapshot_api.zig`: Kitty storage per screen,
  TSS5; limits re-applied after the image store loads.
  `internal/terminalcore/source/sixel_api.zig`: image settings and Clear
  images cover Kitty. Snapshot magic updated in Go tests and `source.json`.
- `web/terminal-sixel-renderer.mjs`: `readKitty`, `pruneKitty`,
  `kittyBitmap`, `renderKitty`; the overlay path includes Kitty placements;
  placeholder characters (U+10EEEE) are not drawn.
- Known limits: z < 0 not drawn; no selection highlight over images; an image
  in mid-chunked transmission is not carried by snapshots; both the host and
  each browser hold decoded pixels (up to the image memory setting per
  screen). Task 294 removes the first three and fixes a snapshot taken inside
  an APC string.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
