# Task 186: Terminal core build mode and asset caching

Status: proposed

Two performance opportunities found alongside task 185 and deferred.

## Terminal core optimization mode

`scripts/build-terminal-core.mjs` builds the Ghostty core with
`-Doptimize=ReleaseSmall`. The server runs it for every PTY read (about
48 MB/s today), and ReleaseFast may be substantially faster. Unmeasured: needs
the pinned Zig and Node.js.

Trade-off: `scripts/build-web.mjs` inlines the same WASM as base64 in
`web/vendor/terminal.js` (about 670 KB of 780 KB), so a larger build grows the
browser download. `terminalcore.Compatibility` hashes the WASM bytes, so
building separate server (ReleaseFast) and browser (ReleaseSmall) variants
would need a compatibility key derived from the source pin instead.

Plan: build both modes, compare `BenchmarkCoreHostOutput` and the browser
bundle size, then decide.

## Module revalidation on page load

Static assets are served `Cache-Control: no-cache`, and `app.js` imports its 20
local modules without the build-hash version used in `index.html`, so every
page load revalidates each module in two or three dependent waves. That is
negligible on a LAN but about 100-150 ms over a 50 ms link. Versioning module
imports at build time would allow `immutable` caching for versioned URLs.
