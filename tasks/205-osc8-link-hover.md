# Task 205: OSC 8 hyperlinks and their address on hover

Status: complete (iPad check pending)

## Request

The visible text of an OSC 8 hyperlink can be anything, so show the link's
URI while the pointer is over it, like a browser's status bar.

## Findings

Building the hover first showed that OSC 8 links had never worked:

- ghostty-web 0.4.0 stubs out the URI lookup (`getHyperlinkUri(id) { return
  null; }`, "not yet exposed in simplified API"), and its OSC 8 provider
  drops every link without a URI. Links were underlined (from the cells'
  hyperlink id) but Cmd-click did nothing, and no hover callback could run.
  The README's Cmd-click line held only for addresses detected in the text.
- The core's cell readers report every hyperlinked cell as id 1
  (`if (cell.hyperlink) 1 else 0`). ghostty-web caches links and underlines
  by that id, so every link on screen counted as the same one.
- ghostty-web's provider opens whatever URI it gets with `window.open`,
  `javascript:` included. Harmless only while the URI was always null.
- The hover underline drew only at the next output: the render scheduler
  paints on request, and a hover change made none. That affected detected
  addresses too.

## Changes

- `internal/terminalcore/source/hyperlink_api.zig`, `scripts/patch-terminal-core.mjs`:
  both cell readers (viewport and scrollback) report `tesseraHyperlinkId`, a
  16-bit hash of the link's page entry (OSC 8 id and URI) — the same on every
  row and page the link spans, so a wrapped link stays one link.
  `tessera_hyperlink_uri(handle, row, col, out, capacity)` copies the URI of
  the link on a cell, rows counted from the oldest scrollback line as
  ghostty-web's buffer counts them, returning the full length.
  `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `7793d1163eaf4ad918521c2489f3d8ec6cad483896ea06debc1eaa8f9da735fb`).
- `web/terminal-links.mjs`: `HyperlinkProvider` finds links by cell id, asks
  the terminal for the URI once per link, and follows the link across row
  ends for its range. It opens only `http` and `https`, with Ctrl or Cmd, like
  the detected-address provider, and reports any URI on hover.
  `replaceHyperlinkProvider` puts it in place of ghostty-web's provider, ahead
  of the address detectors, or changes nothing if that provider is gone.
- `web/terminal-link-hover.mjs`: `TerminalLinkHover` keeps the URI shown and
  tells listeners. `recheck` looks again at the last pointer position once per
  frame after output or scrolling while a URI is shown, since ghostty-web only
  looks again on the next mousemove.
- `web/terminal-entry.js`: `hyperlinkUriAt(row, col)` reads the core through a
  module-owned buffer, grown for long URIs and freed on dispose. On open, the
  provider replaces ghostty-web's and the renderer's hover setters request a
  frame. The pointer is recorded in `processMouseMove` and cleared on
  mouseleave; write and scroll recheck. `onLinkHover(listener)`.
- `web/app.js`, `web/styles.css`: `showTerminalLinkHover` shows the URI in a
  label at the bottom left of the pane, at the right while the pointer is low
  on the left so it does not cover the link; removed with the terminal.
- `web/vendor/terminal.js` rebuilt. `README.md`, `CHANGELOG.md`,
  `docs/terminal-core.md` (the hyperlink API, and building with Zig 0.15.2 on
  macOS 27).

## Building the core on this Mac

Zig 0.15.2 (`~/.local/zig/0.15.2`, checksum verified against ziglang.org)
cannot link native binaries on macOS 27: the SDKs' `libSystem.tbd` stubs list
`arm64e-macos` but not `arm64-macos`, so every libc symbol is undefined, and
`zig build` links a native build runner first. Hiding the SDK
(`DEVELOPER_DIR=/nonexistent`) fixes linking but Ghostty's build asks for the
SDK. What works: `~/.local/zig/sdk-26.5-arm64`, the 26.5 SDK with `usr/lib`
copied and `arm64-macos` added to its stubs (the rest linked), an `xcrun` shim
in `~/.local/zig/sdk-shim` reporting it, and `~/.local/zig/zig-0.15.2`, a
wrapper putting the shim first on `PATH`. With `ZIG=~/.local/zig/zig-0.15.2`,
`npm run verify:terminal-core` reproduced the previous core byte for byte
before this change.

## Validation

- `web/terminal-links.test.mjs`: URIs and ranges for two links on a row, one
  lookup per link; a link wrapped across rows has the same range from either
  row; only http and https open, only with Ctrl or Cmd (`javascript:` and
  `file:` do not); hover reports any scheme; no link without a URI or without
  the lookup; the provider takes the built-in one's place or changes nothing.
  `web/terminal-link-hover.test.mjs`: listeners, recheck once per frame and
  only while shown, dispose. Full JavaScript suite: 663 pass. `go test ./...`
  passes apart from `TestAppModuleImportsAreEmbedded` and
  `TestEveryShippedModuleImportIsVersionedAndResolves`, which fail on the
  unembedded `screensaver.mjs` as before this change. `npm run
  verify:terminal-core` matches the rebuilt core.
- Real host and shell, headless Chrome over the DevTools protocol, a script
  printing three OSC 8 links on one row (`https://example.com/hover-test`,
  `javascript:alert(1)`, `file:///tmp/other`), then clearing the screen, then
  printing a link on the bottom row:
  - hovering each link showed its own URI; moving off hid the label; only the
    hovered link was underlined, at once;
  - Cmd-click on all three opened only `https://example.com/hover-test`;
  - clearing the screen under a still pointer hid the label;
  - the bottom-row link's label sat at the right;
  - no page errors.
- Not yet tried in Safari on the iPad.
