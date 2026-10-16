# Task 181 — System account sign-in

Status: planned

## Request

Require sign-in before Tessera grants workspace, terminal, file, or proxy
access. Authenticate with the password of the operating-system account that
the Tessera process runs as, so access to Tessera means the same thing as
access to that account. Keep signing in rare on trusted devices, revocable, and
compatible with the iPad workflow and a future native iPad client.

Also close the DNS-rebinding gap left by task 030: origin checks compare
`Origin` with `Host`, but no `Host` is ever rejected, so a hostile page whose
domain resolves to `127.0.0.1` passes them.

## Scope and non-goals

- One identity: the account returned by `os/user.Current()`. The login form
  accepts only its password; no other system usernames are accepted or
  checked.
- `-users` remains workspace selection after sign-in. It is not an identity
  or authorization boundary, and the documentation must say so.
- No per-user authorization within Tessera. Every signed-in session can open a
  terminal as the service account, so finer rules would not restrict access.
- No re-authentication before individual sensitive actions, for the same
  reason.
- The native macOS desktop target keeps its existing per-launch credential
  (`internal/server/native_policy.go`) and never shows the login page.
- Native iPad client device tokens are a follow-up task; this task leaves
  room for them in the session model.

## Requirements

### Host allowlist

- Reject requests whose effective `Host` is not allowed with `421 Misdirected
  Request` before routing and rate limiting. Apply it to every path,
  including static assets, `/login`, WebSocket upgrades and the proxies.
- Allowed by default: `localhost`, `127.0.0.1`, `[::1]`, the literal `-addr`
  host when it is not a wildcard, the machine hostname and `<hostname>.local`,
  and every name or address in the local HTTPS certificate. Literal IP
  addresses of the host's interfaces are allowed when bound to a wildcard.
- Add a repeatable/comma-separated `-allowed-host` flag for other names, such
  as a reverse-proxy or Tailscale MagicDNS name.
- Use the trusted-proxy-derived host from task 030 when the peer is a trusted
  proxy; otherwise use `r.Host`.

### Password verification

Define a small `internal/sysauth` package with one operation, verifying the
current account's password, and platform implementations:

- **Linux:** run `unix_chkpwd <user> nonull` (search `/usr/sbin`, `/sbin`),
  write the password and a NUL byte to stdin, and treat exit status 0 as
  success. No cgo; Linux release builds stay `CGO_ENABLED=0`. The helper is
  setuid and only verifies the calling account, so it fails under
  `NoNewPrivileges=true`. Add a comment in `scripts/install-ubuntu.sh`
  explaining why the unit must not set it.
- **macOS:** use OpenDirectory `ODRecordVerifyPassword` through cgo; darwin
  release builds already use `CGO_ENABLED=1`. Never pass the password in
  process arguments (`dscl -authonly` would expose it to `ps`).
- **Windows:** `LogonUserW` with `LOGON32_LOGON_NETWORK` through
  `golang.org/x/sys/windows`, closing the returned token.
- **Others / unavailable:** report "unavailable" distinctly from "incorrect"
  so the login page can show recovery instructions.
- Bound each verification with a timeout. Never log, audit, retain, or return
  the password; zero the request buffer after use where practical.

### Token-file recovery

- On first start, create `<config dir>/tessera/auth-token` (mode `0600`,
  parent `0700`) holding 32 random bytes. Refuse to use a file that is not
  owned by the service account or is group/world readable.
- `tessera login` reads the file, requests a single-use sign-in link from the
  running server over loopback, prints it, and opens it when a browser is
  available. Links expire after 2 minutes.
- `tessera logout --all` revokes every session.
- This is the documented path when the account has no usable password or
  verification is unavailable, so the owner can never be locked out.

### Sessions

- Store sessions in SQLite through the next append-only migration: ID,
  SHA-256 of the cookie secret, created, last seen, idle limit, absolute
  expiry, kind (`remember`, `browser`, `link`), client IP and user-agent
  summary at creation, last-seen IP, and revoked time. Never store the cookie
  secret itself.
- Cookie: `tessera_session`, 32 random bytes, `HttpOnly`, `Path=/`,
  `SameSite=Strict`, `Secure` when the effective request is HTTPS. A
  persistent `Max-Age` only for "Keep me signed in".
- Default lifetimes, configurable with `-session-idle` and `-session-max`
  (which set the remembered values; unremembered values remain the fixed
  shorter defaults unless the flags are lower):

  | Kind | Idle | Absolute |
  |---|---|---|
  | Keep me signed in | 30 days | 90 days |
  | Not remembered | 12 hours | 7 days |

  Enforce both on the server; browsers restore "session" cookies with tabs.
- Slide the idle window on use, writing `last_seen` at most once an hour per
  session and refreshing the cookie `Max-Age` when it is written.
- Remove expired and revoked rows periodically, keeping revoked rows briefly
  enough for live-connection shutdown.

### Request enforcement

- Public without a session: `/login` (GET/POST), its stylesheet and script,
  `/api/health`, and the `/local-https/` enrollment pages and root CA download
  needed to reach HTTPS. Everything else requires a valid session.
- Unauthenticated page navigations get `303` to `/login?next=<path>`. `next`
  must be a same-origin absolute path; anything else becomes `/`.
- Unauthenticated `/api/*` requests get `401` JSON and never redirect.
- WebSocket upgrades (terminal, VNC) verify the session before upgrading.
- Keep the `/browser-proxy/` capability exception from the desktop policy:
  sandboxed opaque-origin requests carrying a valid proxy session ID are
  accepted without the app cookie; creating and deleting proxies still need
  it. Strip `tessera_session` (and all cookies) from every proxied request, as
  the desktop policy does, and keep stripping target `Set-Cookie`.
- With authentication present, keep task 030's origin checks and add
  `SameSite=Strict` as the session-bound CSRF defense task 030 deferred.
  State-changing requests with a session cookie and no `Origin` are rejected.
- Desktop mode continues to use `desktopHandler` only.

### Live connection revocation

- Track open WebSocket connections per session.
- On sign-out, revocation, `logout --all`, or expiry, close them with close
  code `4401` and reason `authentication required`. Check expiry at least once
  a minute for open connections.
- Terminal processes keep running; only the transport closes.

### Login page

- Served by Go as a standalone HTML form at `/login`; it must not load
  `app.js` or call workspace APIs. Use the BeOS dialog styling and apply the
  cached theme the way `web/startup.js` does to avoid a flash.
- Content: "Sign in to Tessera", "`<user>` on `<hostname>`", password field,
  "Keep me signed in on this device" (unchecked by default), and Sign In.
- Include a hidden `<input name="username" autocomplete="username">` with the
  account name and `autocomplete="current-password"` on the password field so
  Safari / iCloud Keychain and other password managers save and autofill it.
- The form posts with normal navigation and works without JavaScript; a small
  script only adds the throttling countdown.
- Errors: a single generic "Incorrect password." While throttled, disable
  Sign In and count down from the server's `Retry-After`.
- Plain HTTP from a non-loopback peer: do not render the password field.
  Explain that signing in from another device requires HTTPS and link to the
  local HTTPS address and enrollment guidance (reuse the copy and logic from
  `web/ipad-http-guidance.mjs`). Reject such POSTs server-side regardless.
- Verification unavailable: replace the form with instructions to run
  `tessera login` on the host.
- On success, create the session, audit it, and `303` to `next`.

### Throttling

- Separate from the general API limiter. Per client IP: no delay for the first
  3 failures, then exponential backoff from 2 s to a 15 min cap, reset by a
  success. Globally: at most 10 verifications per minute across all clients.
- Run at most one verification at a time.
- Bound the tracked IP table and expire idle entries.

### In-app behavior

- When an API call returns `401` or a WebSocket closes with `4401`, dim the
  workspace and show the sign-in dialog as a modal instead of navigating away.
  Submit with `fetch` to a JSON variant of the login endpoint, then resume:
  retry the failed request and let terminals reconnect and restore through the
  existing paths. Do not discard unsaved editor content.
- Deskbar menu: **Sign Out** (revokes the current session, then shows
  `/login`).
- Settings → **Signed-in devices**: list sessions (this device marked, browser
  summary, IP, created, last active), **Sign out** per row, and **Sign out
  everywhere**. Add authenticated endpoints for list and revoke.

### Audit

When `-audit-log` is enabled, record sign-in success, failure, throttled
attempts, sign-out, revocation, link sign-in, and expiry-driven disconnects,
with session ID (not secret), client IP, and outcome. Never record passwords,
cookies, or tokens.

## Configuration

New flags: `-allowed-host`, `-session-idle`, `-session-max`. New commands:
`tessera login`, `tessera logout --all`. There is no option to disable
authentication on the server target; recovery is the token file.

Upgrading changes existing installs: the first visit after upgrade shows the
login page. Document this in `CHANGELOG.md` as a breaking change, including
the Linux account-without-password case and the recovery command.

## Tests

- Host allowlist: allowed names, rejected rebinding hosts, wildcard binds,
  `-allowed-host`, trusted-proxy hosts, and rejection before routing.
- `sysauth`: fake helper binaries for Linux success/failure/missing/timeout;
  password never in arguments or logs. Build-tagged platform tests.
- Sessions: creation, hashing, idle and absolute expiry for both kinds,
  throttled `last_seen` writes, revocation, cleanup, and migration.
- Enforcement: public route list, redirect vs `401`, `next` sanitization,
  WebSocket rejection before upgrade, proxy capability exception, cookie
  stripping, missing-`Origin` mutation rejection, desktop mode unaffected.
- Live revocation closes terminal and VNC sockets with `4401` while the
  terminal process survives.
- Throttling: backoff schedule, `Retry-After`, global cap, single-flight, and
  table bounds.
- Login page: HTTP-from-remote hides the form and rejects POST, unavailable
  state, autocomplete attributes, generic errors.
- Token file: permissions, ownership refusal, single-use 2-minute links,
  `logout --all`.
- Frontend: `401`/`4401` handling shows the modal and resumes without reload;
  devices list and revocation UI.
- Run `gofmt`, `go vet ./...`, `go test ./...`, `go test -tags desktop
  ./internal/nativeapp ./cmd/tessera-desktop`, and `node --test
  web/*.test.mjs`.

## Manual verification

- Ubuntu service install: sign in with the service account password; confirm
  the unit still lacks `NoNewPrivileges`; recover with `tessera login` on an
  account with a locked password.
- macOS server build and Windows build: sign in, wrong password, throttling.
- iPad Safari over local HTTPS: iCloud Keychain saves and autofills; session
  survives Safari restart only when remembered; expiry modal resumes the
  workspace and terminals.
- DNS rebinding: a hostname resolving to `127.0.0.1` receives `421`.

## Documentation

Update `README.md` (replace the "no authentication" boundary with the new
model, keeping the warning against direct public-internet exposure and stating
that `-users` is not access control), `ARCHITECTURE.md` (request pipeline,
session store, `sysauth`), `docs/` for recovery and session settings, and
`CHANGELOG.md`.
