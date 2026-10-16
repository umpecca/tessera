# Task 186: Terminal core build mode and asset caching

Status: complete

## Request

Try the two performance items deferred from task 185: build the terminal core
for speed, and stop page loads revalidating every module.

## Terminal core optimization mode: rejected

Built the pinned core both ways with Zig 0.15.2. The `ReleaseSmall` build
reproduced the committed `ghostty-vt.wasm` byte for byte (sha256 `6b5cc00e…`).

| Workload (server core) | ReleaseSmall | ReleaseFast |
|---|---|---|
| 8 KiB build output | 46.5 MB/s | 50.6 MB/s (+9%) |
| Plain text | 44 MB/s | 48.6 MB/s (+10%) |
| Progress redraw | 34.8 MB/s | 35.1 MB/s |
| Effects | 27.5 MB/s | 26.2 MB/s (−5%) |
| WASM size | 503 KB | 3.4 MB |

About 10% at best, for a core almost 7x larger that is also inlined as base64
in the browser bundle. Optimization level is not the bottleneck. Kept
`ReleaseSmall`; no change.

### Where the server core's time goes

The server core costs a flat ~20 ns per byte (~24 ns per 2-byte character)
whether the input is plain text, escape sequences, wrapping or scrolling, so
no single workload is the problem. The same patched core, same kind of
8 KiB output:

| Engine | Throughput |
|---|---|
| wazero, in the Go server | 46.5 MB/s |
| V8 (`node scripts/benchmark-terminal-core.mjs`) | ~114 MB/s |
| Native `lib-vt`, ReleaseFast with SIMD (C harness) | ~157 MB/s |

- Tessera's patches cost nothing: upstream ghostty-web's core runs at the
  same speed in V8.
- WASM builds disable Ghostty's SIMD (its C++ dependencies cannot target
  WASM), so `nextSlice` parses byte by byte. That matters less than it
  sounds: even the SIMD path calls `print` per codepoint, and grid writes
  dominate. A stream-level ASCII fast path would gain little.
- wazero runs this WASM about 2.5x slower than V8, consistent with its
  explicit memory bounds checks.
- A native core (cgo) would gain at most ~3.4x, at the cost of cgo builds for
  every release target and a C toolchain in CI. Not pursued: interactive
  output is far below these rates, and the limit only shows in floods
  (`cat` of a large file) and on low-power servers.

### Building the core on macOS 26+

Zig 0.15.2 cannot link native macOS programs against SDK 26 or later: their
`.tbd` stubs list `arm64e-macos` but not `arm64-macos`, so the host test and
the `zig build` runner fail with undefined `_malloc`, `_exit`, etc. The WASM
artifact is unaffected. Workaround used: an APFS clone of the SDK with
`arm64-macos` added to each `.tbd` target list, and an `xcrun` wrapper first
on `PATH` that reports that clone for `--show-sdk-path`. CI builds on Linux
and is unaffected.

## Versioned module imports and immutable caching: done

Every asset was served `no-cache`, and `app.js` imported its modules at bare
URLs, so each page load revalidated every module in dependent waves.

- For embedded assets, the server rewrites relative module specifiers in
  Tessera's own `.js`/`.mjs` (static `import`/`export … from` and literal
  dynamic `import()`) to carry the build hash, once at startup. Hand-written
  versions such as `vendor/vnc.js?v=novnc-1.7.0` are replaced by the hash.
  Vendor bundles have no relative imports and are served unchanged.
- A request whose `?v=` equals the current build hash is served
  `public, max-age=31536000, immutable`. Everything else, including
  `index.html`, unversioned and stale URLs, and SPA fallbacks, stays
  `no-cache` with its ETag. The build hash covers every served file, so any
  change produces new URLs.
- Assets served from disk (`-web`, any file with a modification time) are
  neither rewritten nor cached for good, so dev edits still apply.
- The Opus worker URL (`new URL(…, import.meta.url)`) is not an import and
  stays unversioned and revalidated.

## Validation

- New tests: specifier rewriting (both quote styles, existing versions,
  mismatched quotes and absolute URLs untouched, vendor untouched), cache
  headers per URL, disk assets left alone, and a check over the real shipped
  module graph that every relative import carries the hash and resolves to a
  shipped file (a missed form would load a module twice).
- Real server: versioned `app.js`, modules and vendor bundle return
  `immutable`; `/` and bare `app.js` return `no-cache`; gzip still applies.
- Headless Chrome loads the app with no console errors and completes startup.
- Full Go and JavaScript suites pass.
