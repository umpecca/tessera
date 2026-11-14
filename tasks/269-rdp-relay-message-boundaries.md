# Task 269: Fix in-page RDP stream loss from merged relay messages

Status: phases A and B implemented and automated checks pass (2026-11-13);
live RDP and iPad acceptance pending.

## Request

In-page RDP on the iPad app (and likely desktop browsers) fails with
"Could not connect to the RDP server: read frame: [ironrdp_pdu::find_size]
invalid `fastPathLength` at offset 1: length is smaller than the Fast-Path
header". Fix the regression.

## Cause

ironrdp-web reads the connection sequence through a buffered `Framed`, then
calls `framed.into_inner_no_leftover()` and wraps the WebSocket in a fresh
`Framed` for the session (`crates/ironrdp-web/src/session.rs`, IronRDP
7fc80c4d line 1779). The leftover check is a `debug_assert`, so the release
build silently drops any bytes already read past the last connection PDU.

Since 5de3890 (2026-11-04), `relayToWebSocket` merges server reads that queue
behind a message being sent. The server's first session PDUs can then share a
WebSocket message with the last connection PDU; IronRDP drops them and reads
the next PDU from mid-stream. Timing-dependent, so more likely over slower
links (iPad) than localhost. Host-kept sessions do not use this path, and the
headless client already carries its leftover bytes (`pending:
BytesMut::from(&*leftover)`).

## Scope

- **A:** the in-page RDP proxy (`relayRDP`) sends each server read as its own
  WebSocket message again, as before 5de3890. VNC keeps merging.
- **B:** an IronRDP patch (`0013`) carries the connection `Framed`'s leftover
  bytes into the session's `Framed` (`new_with_leftover`); rebuild
  `web/vendor/rdp.js`, bump its cache key, then re-enable merging for RDP
  (which retires A).
- No changes to kept sessions, VNC or the headless module.
- Approval: the user chose "both, do A now" (2026-11-13), then "now do B".

## Acceptance criteria

- [x] A: `relayRDP` stopped merging server reads, with a regression test
  (superseded by B; the helper and its tests were removed with it).
- [x] B: IronRDP keeps leftover bytes across the connect/session handoff
  (patch 0013); rebuilt `rdp.js` passes the interop test with RDP merging
  re-enabled.
- [ ] Live: in-page RDP connects reliably against Remotr with merging on
  (manual, pending).
- [ ] Live: in-page RDP from the iPad app (manual, pending).

## Verification

- Phase A, 2026-11-13 (Go 1.27.4, macOS): `gofmt -l`, `go vet
  ./internal/httpapi`, `go test ./internal/httpapi -count=1` and
  `TESSERA_RDP_INTEROP=1 go test ./internal/httpapi -run IronRDP` passed.
- Phase B, 2026-11-13. Toolchain installed with `brew install rustup wasm-pack
  binaryen` and `rustup toolchain install 1.94.1` (wasm32-unknown-unknown,
  wasm32-wasip1, clippy, rustfmt). Built in a scratch clone of the
  `tessera-headless` branch (patches 0001–0012) with the fix committed on top.
  - `cargo fmt -p ironrdp-web --check`: clean.
  - `cargo clippy -p ironrdp-web --target wasm32-unknown-unknown -- -D warnings`:
    no warnings.
  - ironrdp-web Node tests (`wasm-pack build --dev --target nodejs`, then
    `node --test crates/ironrdp-web/tests/websocket_protocols.cjs`): 21/21 passed.
  - Release `rdp.js` built per `third_party/ironrdp/README.md`.
  - Tessera: `go vet ./internal/httpapi`, `go test ./internal/httpapi
    -count=1`, `TESSERA_RDP_INTEROP=1 go test ./internal/httpapi -run IronRDP
    -count=1 -v` (handshake, changed certificate, standard security,
    negotiation failure), `node --test web/rdp-*.test.mjs` (144/144) and
    `npm run build:web`: all passed.
- Not covered automatically: the interop test's fake server stops at CredSSP,
  so no automated test reaches the connection/session handoff. Faking the full
  sequence (MCS, licensing, capabilities, finalization) was out of scope.
- Build reproducibility: a build of 0001–0012 on this Mac is not
  byte-identical to the previously committed `rdp.js` (minified names and the
  wasm differ), so the toolchain or npm packages differ slightly from that
  earlier build. Between this Mac's builds with and without 0013, the
  wasm-bindgen glue differs only in closure shim indexes.

## Implementation notes

- Task created before implementation.
- Phase A added `relayEachRead` and used it in `relayRDP`; phase B removed
  both again, so `internal/httpapi/websocket_relay.go` and its test are
  unchanged from 5de3890.
- `third_party/ironrdp/patches/0013-fix-web-keep-bytes-read-past-the-connection-sequence.patch`:
  `connect` returns `framed.into_inner()`'s leftover; `Session` keeps it with
  the read half; `run` starts the session's `Framed` with `new_with_leftover`.
  Only `ironrdp-web` changes, so `ironrdp_headless.wasm` was not rebuilt.
- `web/vendor/rdp.js`: rebuilt. `web/rdp-session.mjs`: cache key
  `ironrdp-7fc80c4d-tessera.4`.
- `internal/httpapi/rdp_proxy.go`: `relayRDP` merges again, with a comment
  naming patch 0013.
- `third_party/ironrdp/README.md`: patch 13 listed; cache-key location
  corrected (it moved from `web/app.js` to `web/rdp-session.mjs`).
- `CHANGELOG.md`: Unreleased entry.
- The `IronRDP-headless` worktree was left unchanged; the 0013 commit exists
  only in the scratch clone. To keep the branch in step, apply the patch there
  (`git am third_party/ironrdp/patches/0013-*.patch`).
- Remaining: a live in-page connection to Remotr with merging on, and the
  iPad, after the Tessera server is rebuilt and restarted.
