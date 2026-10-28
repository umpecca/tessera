# Task 238: Keep RDP sessions on the host

Status: Phases 1-3 and 5 built (audit events deferred); iPad test passed for attach, resume, idle limit and Disconnect; rest of Phase 4 to do

Let an RDP pane's session keep running on the Tessera host while no browser
shows it, so that closing Tessera and coming back resumes the remote desktop
where it was: without typing the password again, and without the remote side
locking itself, as Remotr locks the Mac when its client disconnects.

## Background

The RDP pane (tasks 236 and 237) runs IronRDP in the browser page. The host
only relays the session over RDCleanPath. Closing the page ends the RDP client,
so the connection drops and the server treats it as a disconnect. With Remotr
that locks the Mac, and Tessera, which never stores the password, asks for it
again.

The host can't simply hold the connection and hand it to the next page. A live
session's state lives in the client that negotiated it: channel IDs, the share
ID, the bulk-compression history, the Graphics Pipeline's surfaces and caches.
A fresh IronRDP can only start a session, not continue one. So the RDP client
has to live somewhere that outlives the page: the host. Browsers then become
viewers that attach to it and detach from it.

### Findings (2026-10-27, iPad, Remotr on the Tessera host itself, `localhost:3389`)

A probe build of IronRDP (worktree `IronRDP-arc`, branch `tessera-arc-probe`)
logged session events and could pause and resume display updates:

- **The session survives a disconnect.** The remote session ID was the same
  (1) after closing Tessera and reconnecting.
- **Remotr issues an auto-reconnect cookie** (`logon_id` 1) at logon.
- **Remotr locks the Mac on disconnect**, and reconnecting with the password
  lands on the macOS lock screen.
- **While a client is connected, the Mac's own display shows the login
  screen.** Keeping a connection open does not unlock the Mac for someone at
  it. The user requires this.
- **Remotr supports Suppress Output and Refresh Rect** (`suppress_output` and
  `refresh_rect` both true). Suppressed, it sent 0 updates over 3 s and over
  about 30 s. On resume it repainted 100% of the screen within 3 s (24 and 36
  updates). This was tested with EGFX but without H.264, which needs HTTPS;
  resume with H.264 is not yet verified.
- Tessera and Remotr run on the same Mac, so the kept connection stays on the
  machine.

## Decisions

- **A headless RDP client on the host** owns each kept session. A browser
  attaches as a viewer over a WebSocket and detaches when it closes.
- **Standalone:** the host runs IronRDP compiled to WebAssembly inside Go with
  wazero, as `internal/terminalcore` already runs the Ghostty core. No CGO,
  so Tessera stays one binary and Linux builds stay CGO-free. Considered and
  rejected: linking IronRDP as a native library (needs CGO), and a Go-native
  RDP client (far too large).
- **H.264 passes through.** The host never decodes it: each H.264 picture and
  its regions go to the attached viewer, which decodes and draws it with the
  task 237 presenter (`web/rdp-h264.mjs`). Other updates are composited on the
  host by IronRDP and sent as image regions.
- **Paused while nobody watches.** With no viewer attached, the host sends
  Suppress Output (allow = false), so the server sends nothing and the host
  does almost no work. On attach it sends Suppress Output (allow = true), and
  the server repaints the whole screen. Refresh Rect is the fallback for
  servers without Suppress Output.
- **The auto-reconnect cookie stays in host memory only** and is never
  written to disk. It lets the host rejoin the same session if the
  host-to-server connection drops. With Remotr the rejoin still needs the
  password, because Remotr requires CredSSP (Phase 0), so the pane asks for it
  again after a drop. After a real drop, Remotr shows the lock screen, which
  is the right behaviour.
- **The password goes to the host.** CredSSP now runs on the host, so the
  password the user types reaches the host process once, for the connection,
  and is dropped afterwards. It is still never stored. This changes task 236's
  rule that the password never leaves the browser. So kept sessions need HTTPS
  (or loopback) between browser and host, which H.264 needs anyway.
- **Opt-in, only with sign-in.** Keeping a session is a per-pane choice, offered
  only when Tessera sign-in is enabled (`-auth system` or `-auth file`). A kept
  session belongs to the Tessera user who started it, and only that user can
  attach. Tessera's terminals already give a signed-in user a shell on the host,
  so this adds no new class of access for the same macOS user, but a logged-in
  desktop must never be reachable without signing in.
- **Bounded lifetime.** An idle limit (no viewer attached for N hours,
  configurable) ends the session, and the server then locks. **Disconnect**
  ends it at once. A Tessera restart ends every kept session.
- **One viewer at a time.** A new attach takes over from the previous viewer.
- **Both paths stay.** Panes that aren't kept keep using the in-browser
  IronRDP and the RDCleanPath gateway, unchanged. Moving every pane to the
  host-side client can be considered once this one has proven itself.

## Phase 0: spike

Prove the risky part before building the rest. Stop and record findings here
if it fails.

- A small Rust crate in the IronRDP branch, for example `ironrdp-headless`,
  built to WebAssembly with a byte-oriented interface and no browser APIs. Go
  owns TCP and TLS and hands over the server's public key for CredSSP. The
  crate runs the connector and `ActiveStage`, takes bytes from the server and
  input events from Go, and returns bytes to send plus display events: H.264
  pictures with regions, composited image regions, pointer and desktop-size
  changes, and the auto-reconnect cookie.
- Load it with wazero in a Go test harness. Connect to Remotr, run CredSSP,
  and reach an active session.
- Measure: CPU per frame with Remotr's H.264 stream (no decoding, so it
  should be small), memory, module compile time, and binary size growth.
- Verify against Remotr: idle under Suppress Output for 10+ minutes with no
  disconnect and no lock; resume repaints fully **in H.264 mode**, the one
  unverified finding; after a forced TCP drop the cookie rejoins the same
  session ID.
- Check what the crate's dependencies need from the WebAssembly environment
  (clock, random numbers, CredSSP's crypto), and that wazero provides it
  without CGO.

### Phase 0 results so far (2026-10-27)

The spike lives in IronRDP worktree `IronRDP-headless`, branch
`tessera-headless`: a crate `ironrdp-headless` built for `wasm32-wasip1`
(5.9 MB). It imports four host functions (`tessera.recv`, `send`,
`upgrade_tls`, `event`) plus basic WASI calls (random, clocks, environment,
files) and exports `alloc` and `run`. It uses `ironrdp-blocking` for the
connection sequence and CredSSP, does its own framing in the session loop so
host commands can arrive while the server is silent, hands H.264 over through
the task 237 `presents_frames` hook, and sends Suppress Output on command.
wazero needs `WithSysWalltime`, `WithSysNanotime` and a `crypto/rand` source:
its defaults are deterministic, and NTLM needs real time and randomness.

A throwaway Go harness drove it against Remotr on `localhost:3389`:

- The module compiled in 0.76 s. TLS 1.3 (certificate CN=Remotr), CredSSP
  and the connection sequence completed inside WebAssembly; the session was
  active 0.95 s after starting.
- Remotr confirmed suppress output and refresh rect support, session ID 1, and
  sent an auto-reconnect cookie, which stayed in the module.
- Receiving for 10 s: 335 H.264 frames (about 3 MB, about 33 fps), 100% of the
  screen painted, 0.20 s of host CPU (about 2% of one core).
- Paused for 60 s: 0 frames, 0.00 s of host CPU, and the connection stayed up.
- Resumed: 119 H.264 frames repainted 100% of the screen within 3 s. **Resume
  in H.264 mode is verified.**
- Memory: 13.6 MB of WebAssembly linear memory, 33 MB of Go heap for the
  whole harness.

- A 10-minute pause: 0 frames and 0.01 s of host CPU over the whole pause, the
  connection stayed up, and resume repainted 100% of the screen within 3 s.
- wazero's compilation cache (`NewCompilationCacheWithDir`) cuts the compile
  from about 0.8 s to 32 ms after the first start, for an 18 MB cache
  directory. Tessera would keep it beside its database.

Rejoin: the module now keeps the latest cookie internally (it never reaches
Go) and can reconnect presenting it, with CredSSP or TLS only. The cookie
travels in the Client Info PDU, which comes after CredSSP, so a CredSSP rejoin
still needs the password; only a TLS-only rejoin can avoid it, if the server
accepts connections without CredSSP.

Live rejoin run against Remotr (connect, drop the TCP connection without a
graceful shutdown, rejoin, drop, rejoin):

- **CredSSP with the password, plus the cookie: works.** The rejoin connected
  in 0.15 s to the same remote session (ID 1) and repainted 100% of the screen
  within 3 s; Remotr issued a fresh cookie.
- **TLS only, without the password, plus the cookie: refused.** Remotr
  answers "server requires Enhanced RDP Security with CredSSP".
- After the rejoin, Remotr showed the macOS lock screen. The Mac was already
  locked going in (the previous run ended with a disconnect), so this doesn't
  show whether the rejoin itself locks; a drop is a disconnect, after which
  Remotr locks, so the lock screen is expected either way.

So with Remotr, rejoining after a dropped host-to-server connection without
asking the user needs the password held in host memory for the session's
lifetime. Since the user meets the lock screen after a drop anyway, Phase 1
should not keep it: after a drop the pane asks for the password again, and the
host rejoins the same session with it and the cookie. Drops between the host
and a server on the same machine should be rare.

Phase 0 is done: the spike is complete, with the decision above recorded. Input,
reactivation (`DeactivateAll`) and resize are Phase 1 work: the spike doesn't
handle them.

## Phase 1: host session manager

Progress (2026-10-27):

- **The module** (patches `0004` and `0005`, branch `tessera-headless`): the
  spike crate made production-ready. It adds input (mouse, buttons, wheel,
  scan codes, Unicode, release-all) through `ironrdp_input::Database`, resize
  through Display Control, refresh, the Deactivation-Reactivation Sequence
  (buffered reads that keep host messages arriving meanwhile), desktop-size
  events for reactivation and EGFX `ResetGraphics`, RGBA regions for updates
  other than H.264, an end code that tells a lost connection (rejoin) from a
  quit, a server end and an error, and wiping of the configuration and its
  password once read. The byte formats are in `wire.rs` with unit tests;
  clippy and rustfmt are clean for native and `wasm32-wasip1`.
- **The engine** (`internal/rdpsession`): embeds the module, compiles it once
  (with an optional compilation cache), registers the `tessera` host
  functions, and runs one module instance per session over a `Link` the
  session supplies. `wire.go` mirrors the byte formats and validates viewer
  input before it reaches the module, which ends a session on input it can't
  parse. Tests drive the real module through a scripted link: negotiation and
  a failed TLS upgrade, a vanished connection, two runs on one instance, the
  compilation cache. They pass with `-race`.
- **The server connection** (`conn.go`): dials the server and upgrades to TLS
  when the module asks, accepting only the certificate the user trusted
  (`ErrCertificateChanged` otherwise). After the login a reader goroutine feeds
  the module, so host messages reach it while the server is silent.
- **The session** (`session.go`, `session_run.go`): `Start`, `Rejoin`, `Close`,
  `Post`, `Info`, `Done`. States are connecting, active, lost (the connection
  dropped and the server issued a cookie, so it can be rejoined) and ended. The
  password is encoded into the module's settings and not kept; a rejoin asks for
  it again. A failed rejoin leaves the session lost so it can be retried.
- **Viewers and the idle limit** (`viewer.go`): one attached viewer at a time.
  Attach asks the server to repaint, sends the viewer the desktop size, and a
  new attach takes over from the old one; detach pauses the server's display and
  starts the idle clock; a session with no viewer for the idle limit ends, lost
  ones included. The default is 8 hours (`DefaultIdleLimit`); making it
  configurable is Phase 3.
- **The manager** (`manager.go`): sessions keyed by owner and pane, one module
  instance each (it holds that session's cookie), a lazily compiled engine so
  servers that never keep a session pay nothing, `Shutdown` ending everything.
  `internal/server` creates it with its compile cache in `rdp-module-cache`
  beside the database and shuts it down with the server. The binary grew by
  about 6 MB (37.8 to 44.0 MB).
- **The API** (`internal/httpapi/rdp_kept.go`, `rdp_kept_view.go`), registered
  in `Register`; the manager reaches it through `app.App.RDPSessions` and
  `httpapi.API.RDPSessions`:
  - `GET /api/rdp-kept` lists the caller's kept sessions; `POST` keeps a new
    one (workspace, pane, target, trusted fingerprint, user name, domain,
    password, desktop size, H.264). `POST /api/rdp-kept/rejoin` (with the
    password) and `/disconnect` act on a pane's session. The password is
    never in a response.
  - `GET /api/rdp-kept/view?workspaceId=&pane=` upgrades to a WebSocket that
    carries the viewer protocol (`internal/rdpsession/viewer_protocol.go`):
    host to viewer, desktop size, H.264 pictures, image regions, the end of the
    session and "another viewer took over"; viewer to host, input records,
    resize and refresh. Messages are validated before they reach the module,
    and an invalid one closes the socket. A viewer that falls 256 frames behind
    is dropped, so it can't slow the session; attaching again repaints.
  - Rules, in `rdpKeptOwner` and `rdpKeptKey`: kept sessions need Tessera
    sign-in (`-auth file` or `system`); the caller must be signed in and the
    request must be HTTPS or from loopback; the key is the signed-in account
    plus workspace and pane, so one account can't reach another's session,
    and the workspace must be one the account may use; the WebSocket's origin
    must match and it closes when the sign-in ends.
- Tests: 30 in `internal/rdpsession` and 5 in `internal/httpapi`, which run
  the real HTTP stack with two file accounts, the fake manager
  (`rdpsession.NewFakeManager`) and a TCP listener for the server. They cover
  the lifecycle, bad requests, the protocol, owner-only access (checked by
  mutation) and the sign-in and HTTPS rules. All pass with `-race`;
  `go test ./...` passes.

- `internal/rdpsession`: kept sessions keyed by owner and pane, with states
  connecting, attached, detached, reconnecting and ended. It handles the idle
  timer, suppress and resume on detach and attach, cookie rejoin, and fanning
  display events out to the attached viewer.
- API: create a kept session (target, user name, domain, password, and the
  trusted fingerprint from the existing certificate flow); attach a viewer
  WebSocket; disconnect; list the caller's sessions so a reopened pane knows to
  attach.
- Viewer protocol over the WebSocket. Host to browser: H.264 pictures with
  regions, image regions, desktop size, cursor, remote clipboard, status.
  Browser to host: mouse, keyboard scan codes, wheel, resize requests, local
  clipboard.
- Reuse the RDCleanPath gateway's certificate checks, target validation and
  trusted-fingerprint rule.

## Phase 2: browser viewer

- A viewer mode in the RDP pane: connect the viewer WebSocket instead of
  loading IronRDP, draw H.264 with `web/rdp-h264.mjs`, and draw image regions
  with `putImageData`. Input maps through the existing `web/rdp-pane.mjs`
  helpers, with the viewer protocol's own encoding replacing IronRDP's
  `DeviceEvent`.
- UI: a "Keep session on host" choice when connecting (shown only when
  signed in and on HTTPS); an indicator while a session is kept; a reopened
  pane attaches automatically, with no password prompt; **Disconnect** ends
  the kept session.
- Clipboard and resize parity with the in-browser pane.

Built (2026-10-27), tested with fakes only; a real browser run is Phase 4:

- `web/rdp-viewer-wire.mjs`: the browser's side of the viewer protocol (input
  records, resize and refresh messages, frame parsing). Its tests and the Go
  tests assert the same byte literals, and a Go test compares the host's
  request fields with the browser's list, so either side's format changing
  fails a test.
- `web/rdp-viewer.mjs`: `connectRDPViewer` attaches over the WebSocket, draws
  image regions with `putImageData` (forcing alpha opaque; the context is
  created with `alpha: false`), hands H.264 pictures to the task 237 presenter,
  and sends input, resize, refresh and release-all. It stands in for the parts
  of IronRDP's session the pane uses (`rdpViewerModule` has the
  `Backend.DeviceEvent` and `Backend.InputTransaction` the pane builds input
  with, and wheel units become pixels as in IronRDP), so the pane's input,
  resize and scaling code is unchanged.
- `web/rdp-kept.mjs`: listing the host's kept sessions (null when the host
  doesn't offer them: sign-in off, not HTTPS or loopback), finding a window's
  session, and building the requests.
- `web/app.js`: Connect first asks the host for the window's session. An active
  one is attached to without prompts; a lost one asks only for the password and
  rejoins; otherwise the usual flow runs, and when the host offers kept
  sessions the credentials dialog has a "Keep this session on the Tessera host"
  checkbox (on by default, remembered in localStorage). A window whose session
  is active attaches by itself when it appears. **Disconnect** and closing the
  window end the session on the host; closing the page or switching workspace
  only detach. The toolbar shows "On host" (and "H.264") while attached.
- `GET /api/rdp-kept` also returns each session's server address, so a window
  attaches to the right session even if its address box was edited.

Known gaps: the remote clipboard isn't carried (the headless module has no
clipboard channel), so the clipboard buttons are disabled for kept sessions; a
viewer without WebCodecs (HTTP, or an old browser) attached to an H.264 session
draws nothing for the video; the pane has no UI yet for how long the host keeps
an unwatched session.

## Phase 3: security and lifecycle

- Enforce sign-in, ownership, and HTTPS or loopback for create and attach.
- Keep the password only as long as CredSSP needs it, and the cookie in memory
  only.
- ~~Audit events for create, attach, detach, rejoin and end (with `-audit-log`).~~
  Deferred (2026-10-27): skipped for now at the user's request.
- An idle-limit setting; document that a restart ends kept sessions.
  Built (2026-10-27): host flag `-rdp-idle-limit` (default 8h, at least 1m,
  so a session always ends eventually), passed as `server.Options.RDPIdleLimit`
  to the manager. `GET /api/rdp-kept` reports `idleLimitSeconds`, and the keep
  checkbox says how long the host waits for a viewer. Tests: flag validation,
  server wiring, API listing, label text. The docs are still to write (Phase 5).

## Phase 4: validation

iPad test 1 (2026-10-27): pointer moves worked, clicks didn't. The viewer
session lacked `synchronizeLockKeys`, which the pane calls on every
pointer-down before sending the press, so each press threw. Fixed with a
no-op (lock-key state isn't carried yet; follow-up: an input record for it in
the headless module) and a test that every session method and DeviceEvent
app.js calls exists on the viewer.

iPad test 2 (2026-10-27, Remotr on localhost:3389, test server with
`-rdp-idle-limit 2m`, over Local HTTPS): passed. Mouse, clicks and keys work;
closing and reopening the tab reattached to the same session without a
password (H.264, On host); after 2 minutes unwatched the session ended with the
idle reason; Disconnect ended it at once. Still untested: reopen after an hour
(needs the default limit), a dropped server connection and the password-only
rejoin, host CPU while detached, a Windows server. The rejoin test waits until
the user is at the Mac (it needs Remotr restarted while a session is kept).

On the iPad with Remotr, over HTTPS:

- Close Tessera; reopen after 1 minute and after an hour. The desktop appears
  at once, with no lock screen and no password prompt.
- The Mac's own display stays at the login screen throughout.
- Kill the host-to-server connection: the host rejoins with the cookie (the
  lock screen is expected after a real drop).
- The idle limit ends the session, and the Mac locks.
- **Disconnect** ends it, and the Mac locks.
- CPU on the host is near zero while detached.
- A Windows server, if available: kept, resumed, and repainted correctly.

## Phase 5: ship

README (the RDP section, security model, sign-in requirement), `ARCHITECTURE.md`
(the host-side client and viewer protocol), `CHANGELOG.md`, the IronRDP patch
series and its README in `third_party/ironrdp/`.

Written (2026-10-27): README "Kept RDP sessions" under RDP connections, the
`-rdp-idle-limit` flag, a sign-in bullet; ARCHITECTURE.md (wazero in the stack,
a "Kept RDP sessions" component entry with the endpoints and viewer protocol,
a security rule); a CHANGELOG entry. The IronRDP README already covered the
headless module and patches 0004-0005. Revisit after Phase 4 if the iPad test
changes any behavior described.

## Risks and open questions

- IronRDP may not run under wazero without browser or OS facilities it
  expects, or may be too slow there. The spike decides.
- Resume in H.264 mode is unverified (Phase 0).
- The password reaching the host changes the security model; the README must
  say so plainly.
- The viewer protocol is new attack surface; it must only ever be reachable
  after sign-in and ownership checks.
- Non-H.264 image regions cost bandwidth, so they may need compression.
- Two RDP paths to maintain until one replaces the other.
- A headless IronRDP crate may be worth proposing upstream; keep it free of
  Tessera specifics.
