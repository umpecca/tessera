# IronRDP (patched)

`web/vendor/rdp.js` is IronRDP's `@devolutions/iron-remote-desktop-rdp` web package, built from
IronRDP `master` at 7fc80c4dbada6fbfe0349ee01f3b0a5ba9457df0 with the series in `patches/`, and
committed as built. Nothing in Tessera's build regenerates it, so building Tessera needs no Rust
toolchain. The bundle inlines its WebAssembly as a `data:` URL. IronRDP's MIT and Apache-2.0
notices are `web/vendor/IronRDP-LICENSE-*.txt`.

The patches let the RDP pane use the Graphics Pipeline (MS-RDPEGFX) with H.264 decoded by the
browser (task 237). `web/rdp-h264.mjs` decodes each picture with WebCodecs and draws it onto the
canvas, so H.264 pixels never pass through WebAssembly:

1. `0001` `ironrdp-egfx`: an `H264Decoder` can present frames itself (`presents_frames`,
   `present`). The client hands it each AVC420 frame with its region rectangles, and both views
   of an AVC444 frame (only the main view to be shown), instead of painting them through the
   compositor.
2. `0002` `ironrdp-web`: the `enable_egfx` and `h264_frame_callback` extensions. The callback
   receives `(data, regions, surfaceId)` for each H.264 picture.
3. `0003` `iron-remote-desktop-rdp`: the `enableEgfx()` and `h264FrameCallback()` factories.

`master` already includes [#1374](https://github.com/Devolutions/IronRDP/pull/1374), which
replaced softbuffer with `putImageData`. The 0.7.0 release Tessera shipped before needed a patch
for that: softbuffer converted every pixel to a `u32` and back one byte at a time, which capped
iPad Safari at about 3 Mpx/s. None of this is in an npm release yet; once IronRDP's web client
supports EGFX with a pluggable decoder itself (upstream #1464, #790), these patches can shrink or
go.

## Rebuilding

Requires `rustup`, `wasm-pack` and `binaryen`; on macOS, `brew install rustup wasm-pack binaryen`.
Homebrew's `rustup` is keg-only: put `$(brew --prefix rustup)/bin` on `PATH`.

```sh
git clone https://github.com/Devolutions/IronRDP.git && cd IronRDP
git checkout 7fc80c4dbada6fbfe0349ee01f3b0a5ba9457df0
git am /path/to/tessera/third_party/ironrdp/patches/*.patch
rustup target add wasm32-unknown-unknown --toolchain 1.94.1   # rust-toolchain.toml at that commit
cd crates/ironrdp-web
RUSTFLAGS='-Ctarget-feature=+simd128,+bulk-memory --cfg getrandom_backend="wasm_js"' wasm-pack build --target web
# Apply the `cargo xtask web build` rewrite of the wasm URL:
node -e 'const fs = require("fs"), p = "pkg/ironrdp_web.js"; fs.writeFileSync(p, "import wasmUrl from \"./ironrdp_web_bg.wasm?url\";\n\n" + fs.readFileSync(p, "utf8").replace("new URL('\''ironrdp_web_bg.wasm'\'', import.meta.url)", "wasmUrl"))'
cd ../../web-client/iron-remote-desktop-rdp && npm install && npm run build-alone
cp dist/iron-remote-desktop-rdp.js /path/to/tessera/web/vendor/rdp.js
```

Then bump the `?v=` cache key on the `vendor/rdp.js` import in `web/app.js`, and run
`TESSERA_RDP_INTEROP=1 go test ./internal/httpapi -run IronRDP` to drive the new client against
the gateway.

To change the series, edit the branch in an IronRDP checkout and export it again with
`git format-patch 7fc80c4dbada6fbfe0349ee01f3b0a5ba9457df0..HEAD -o /path/to/tessera/third_party/ironrdp/patches`.
The series passes IronRDP's `cargo test -p ironrdp-egfx`, the EGFX tests in
`cargo test -p ironrdp-testsuite-core --test integration_tests_core egfx`, the `ironrdp-web` Node
tests (`wasm-pack build --dev --target nodejs --out-dir ../../target/ironrdp-web-tests` in
`crates/ironrdp-web`, then `node --test crates/ironrdp-web/tests/websocket_protocols.cjs`), and
`npm run check` and `npm run lint` in `web-client/iron-remote-desktop-rdp`.
