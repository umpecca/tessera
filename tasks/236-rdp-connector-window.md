# Task 236: RDP connector window

Status: complete (live desktop session against a real RDP server pending)

Add a persistent RDP pane, modeled on the VNC pane (task 094), that uses a
bundled IronRDP WebAssembly client in the browser and a Tessera-owned
RDCleanPath gateway on the server.

## Background

The VNC pane works because noVNC speaks RFB entirely in the browser, so
`internal/httpapi/vnc_proxy.go` only forwards raw bytes between a WebSocket and
a TCP connection. RDP can't work that way: the server expects TLS and usually
NLA/CredSSP, and a browser can't open a TLS connection over a WebSocket to an
arbitrary TCP port.

IronRDP (Devolutions, Rust) builds to WebAssembly and ships a web client that
expects its gateway to speak RDCleanPath:

1. The browser sends an RDCleanPath request PDU (ASN.1 DER) carrying the
   destination, the X.224 Connection Request, and an optional preconnection
   blob.
2. The gateway dials the target over TCP, forwards the X.224 request, reads the
   X.224 Connection Confirm, and runs the TLS handshake with the RDP server.
3. The gateway replies with an RDCleanPath response PDU carrying the X.224
   confirm, the server's certificate chain, and the resolved server address.
   The client needs the certificate chain because CredSSP binds to the server's
   public key.
4. From then on, the gateway forwards bytes between the WebSocket and the TLS
   connection. CredSSP, the remaining connection sequence, input, and graphics
   all run in the browser.

Tessera decrypts the server-side TLS, so the RDP stream is in plaintext inside
the Tessera process and between Tessera and the browser. The browser-to-Tessera
link must therefore be HTTPS (or loopback), and the pane must say so when it
isn't.

## Phase 0: spike

Do this before committing to the full pane.

- Confirm IronRDP's license and record its notices next to the noVNC ones in
  `web/vendor/`.
- Pick the web package to vendor (the `iron-remote-desktop` web component and
  the IronRDP WASM build, or whatever upstream currently publishes). Check the
  bundle size and whether it can be built once and committed as a prebuilt
  artifact, so `scripts/build-web.mjs` doesn't need a Rust toolchain.
- Write down the exact RDCleanPath PDU schema and version from the upstream
  `ironrdp-rdcleanpath` crate. Note which fields Tessera must fill and which it
  can reject (for example the proxy auth token, which Tessera replaces with its
  own capability path).
- Get a minimal Go RDCleanPath handler to connect to a Windows Pro or Server
  host with NLA on, and to an `xrdp` host on Linux. Note which security
  protocols each one negotiates.
- If the spike shows that IronRDP's web client can't be vendored as a static
  bundle, or that RDCleanPath is unstable across releases, stop and record the
  findings here instead of moving on.

## Requirements

- Add RDP to the window menu, workspace menu, command palette, Deskbar, focus,
  persistence, pane cleanup, and centered-window flows, alongside VNC in
  `web/app.js` and `web/pane-activation.mjs`.
- Add `web/rdp-pane.mjs` and `web/rdp-entry.js`, mirroring `web/vnc-pane.mjs`
  and `web/vnc-entry.js`, and bundle them through `scripts/build-web.mjs` and
  `web/embed.go`. Keep Tessera deployable as one Go binary.
- Add `migrations/NNN_pane_rdp_settings.sql` (an `rdp_settings` TEXT column,
  like `038_pane_vnc_settings.sql`). Persist the target, username, domain, and
  scale or resize mode, but never the password.
- Require an explicit Connect action. Keep the password only in page memory and
  clear it on disconnect and on pane close.
- Accept any DNS, IPv4, or IPv6 target reachable from the Tessera host,
  defaulting to port 3389. Require brackets around IPv6 targets, as
  `normalizeVNCTarget` does.
- Server certificates: show the certificate fingerprint on first connect and
  require the user to accept it. Store accepted fingerprints per target in the
  pane settings, warn clearly when a fingerprint changes, and never trust
  silently.
- Support pointer, wheel, and keyboard input including Ctrl+Alt+Del and the
  Windows key, dynamic resize to the pane size where the server supports it,
  disconnect, and useful status and error messages (auth failure, NLA required,
  certificate rejected, host unreachable).
- Clipboard: plain-text send and receive through the same explicit flow as VNC,
  if the vendored client exposes the clipboard channel. Otherwise defer it and
  note that here.
- Out of scope: audio, drive, printer, smart-card, and USB redirection; RD
  Gateway and connection brokers; Kerberos (NTLM only, unless IronRDP's web
  build supports Kerberos without extra infrastructure).

## Server

- Add `internal/httpapi/rdp_proxy.go` with the same shape as `vnc_proxy.go`:
  - `POST /api/rdp-proxy`: checks the workspace, normalizes the target, and
    returns a one-use capability path that expires after 5 minutes.
  - `GET /api/rdp-proxy/connect?session=…`: accepts only same-origin WebSocket
    upgrades and only binary messages, consumes the capability, and closes
    when sign-in ends.
- Handle exactly one RDCleanPath request PDU first, with a size cap. Ignore the
  destination the client sends and dial the target bound to the capability, so
  the client can't redirect the dial.
- Use timeouts for the TCP dial, the X.224 exchange, and the TLS handshake.
  Disable TLS certificate verification for the handshake and send the chain
  back to the browser, which makes the trust decision. Restrict TLS to 1.2 and
  later.
- Return RDCleanPath error PDUs for dial, X.224, and TLS failures, so the pane
  can show which step failed.
- Share the capability manager, origin checks, and target parsing with the VNC
  proxy where that removes duplication, without changing VNC behavior.
- Register the routes and security headers in `internal/httpapi/api.go` and
  `internal/httpapi/security.go`. Allow `wasm-unsafe-eval` in the CSP only if
  the WASM client needs it, and only for the RDP entry.

## Verification

- Go: target parsing (defaults, IPv6, rejects); capability expiry and one-use
  consumption; origin, subprotocol, and message-type rejection; an oversized or
  malformed RDCleanPath PDU; checking that the client-supplied destination is
  ignored; and an end-to-end test against a fake RDP server that answers X.224
  and completes TLS with a test certificate, asserting the response PDU
  contents and then the byte relay.
- Store: migration and settings round trip, with no password stored.
- Frontend: pane helpers, settings persistence, credential clearing,
  fingerprint accept, mismatch and reject flows, and the insecure-transport
  warning.
- Manual: connect to a Windows host with NLA and to an `xrdp` host; check input,
  resize, Ctrl+Alt+Del, clipboard, a certificate change, and a wrong password.
  Do this on the desktop and on the iPad.
- Run the web build, Node tests, JavaScript syntax check, `go test ./...`,
  `go vet ./...`, and `git diff --check`.

## Documentation

- `README.md` and `ARCHITECTURE.md`: the RDP pane, the RDCleanPath gateway, and
  its security model (Tessera sees plaintext RDP; HTTPS is required off
  loopback; certificates are trusted on first use with explicit acceptance).
- Note that the pane connects to an existing RDP server, that macOS has no
  built-in RDP server (a Mac's own Screen Sharing is VNC), and that Windows
  Home editions can't accept RDP connections.
- `CHANGELOG.md`.

## Completion

Phase 0 findings:

- IronRDP's web packages are MIT OR Apache-2.0. Only
  `@devolutions/iron-remote-desktop-rdp` 0.7.0 is vendored: its low-level
  `SessionBuilder`/`Session` API suits a windowed pane better than the
  `iron-remote-desktop` web component, which sizes itself to the browser
  window and listens for keys on `window`. The npm package inlines its WASM as
  a data: URL that the existing CSP allows, so the web build needs no Rust.
  The package ships no license files, so both notices are committed in
  `web/vendor/`.
- RDCleanPath version 3390, as in `ironrdp-rdcleanpath`: a DER SEQUENCE of
  explicitly tagged fields. The client opens the WebSocket with no
  subprotocol and owns the URL, so the capability travels in the path.
- The client cannot pause between the RDCleanPath response and CredSSP, so
  certificate trust is settled before connecting: the pane fetches the
  certificate from a probe endpoint, and the capability is bound to the
  accepted fingerprint, which the gateway checks before relaying.

Implemented:

- `internal/httpapi/rdp_proxy.go`: certificate probe, capability creation
  bound to target and fingerprint, and the RDCleanPath gateway with X.224
  validation, negotiation-failure and Standard-RDP-Security handling, TLS 1.2+,
  Winsock/TLS-alert error mapping, and the relay. VNC target parsing is now
  shared (`normalizeRemoteTarget`) with unchanged behavior.
- `migrations/053_pane_rdp_settings.sql` and store support for target, user
  name, domain, scale mode, and trusted target and fingerprint; never the
  password.
- `web/rdp-pane.mjs` helpers and the RDP pane in `web/app.js`: certificate and
  changed-certificate dialogs, sign-in dialog with an insecure-transport
  warning, pointer, wheel and keyboard input by scancode, lock-key sync,
  CAD and Win buttons, Fit/1:1/Resize, explicit clipboard text in both
  directions, cursor shapes, cancellation and cleanup. Menus, palette (`NR`),
  command wheel, window-type menu, focus and persistence include RDP.

Verification:

- Go tests for target parsing, capabilities, create validation, origin and
  capability rejection, hand-encoded RDCleanPath DER vectors, the TLS relay
  against a fake server, changed certificates, negotiation failures,
  Standard RDP Security and malformed requests; store persistence and
  migration tests; JavaScript helper tests. Full JavaScript suite, `go vet`,
  `go test ./...` and `git diff --check` pass.
- `TESSERA_RDP_INTEROP=1` runs the bundled IronRDP client in Node against the
  gateway: it completes RDCleanPath and sends its CredSSP request through the
  relay, and reports 409, 501 and negotiation failures as expected.
- Headless Chrome against a real host: New RDP, the certificate dialog, the
  sign-in dialog, the WASM client loading under Tessera's CSP and reaching a
  fake server's CredSSP step, persistence without the password across a
  reload, trusted servers skipping straight to sign-in, the changed
  certificate warning, and a read-only certificate probe of the local RDP
  server on port 3389 (TLS, `CN=Remotr`), with no page errors.
- Not yet done: signing in to a real RDP server and checking rendering,
  input, Resize, Ctrl+Alt+Del and clipboard, on desktop and iPad.
