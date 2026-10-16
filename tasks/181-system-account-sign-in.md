# Task 181 — Sign-in

Status: complete (phases 1-3)

## Request

Require sign-in before Tessera grants workspace, terminal, file, or proxy
access. Support the operating-system account Tessera runs as, and, as an
alternative, accounts kept in a Tessera-only credentials file. Keep signing in
rare on trusted devices, revocable, and compatible with the iPad workflow and
a future native iPad (WKWebView) client.

## Decisions (2026-10-16)

- **Off unless enabled.** `-auth=off` stays the default, so upgrading changes
  nothing. `-auth=file` or `-auth=system` turns sign-in on.
- **No cgo** in any authentication code. macOS release builds still use cgo
  for the tray, but authentication must not depend on it.
- **Credentials file holds several accounts, tied to workspaces.** Each
  account signs into its own workspaces, replacing the user picker. All
  terminals still run as the server's OS account, so this separates
  workspaces but does not isolate people from each other; documentation must
  say so.
- **macOS system accounts through purego** (`github.com/ebitengine/purego`),
  calling OpenDirectory's `ODRecordVerifyPassword` without cgo.

Naming: "sessions" already means named desktop sessions. Authentication uses
"sign-in" in code, tables and UI (`auth_sign_ins`, `tessera_signin` cookie).

## Modes

| `-auth` | Who can sign in | Workspaces after sign-in |
|---|---|---|
| `off` (default) | No sign-in | Unchanged: `-users` picker or the default workspace |
| `file` | Accounts in the credentials file | The signed-in account's own; `-users` is rejected at startup |
| `system` | Only the OS account Tessera runs as | Unchanged: `-users` picker or the default workspace |

## Credentials file

- Path: `-auth-file`, default `<user config dir>/Tessera/credentials`.
- One account per line, `name:<PHC hash>`; blank lines and `#` comments
  allowed. Hash: argon2id (`golang.org/x/crypto/argon2`, pure Go), OWASP
  parameters m=19 MiB, t=2, p=1, 16-byte salt, 32-byte key, PHC string format.
- Account names use the same rules as roster names: non-empty, no `/`, `\`,
  `:`, whitespace or control characters, at most 64 bytes.
- Must be owned by the service account and not group/world readable or
  writable (Unix); refuse to load otherwise, with a message naming the fix.
  Created with mode `0600` in a `0700` directory.
- The server re-reads the file when its modification time or size changes, so
  CLI edits apply without a restart: added accounts can sign in, removed
  accounts lose access, and a changed password ends that account's existing
  sign-ins (each sign-in records a tag of the hash it was made with).
- Commands (password never in arguments; prompted twice without echo through
  `golang.org/x/term`, or `--password-stdin` for scripts):
  - `tessera user add <name>`
  - `tessera user passwd <name>`
  - `tessera user remove <name>`
  - `tessera user list`
  Each accepts `-auth-file`. Writes are atomic (temp file and rename).

## System accounts (phase 2)

`internal/sysauth`, one operation: verify the current account's password.

- **Linux:** run `unix_chkpwd <user> nonull` (search `/usr/sbin`, `/sbin`),
  write the password and a NUL to stdin, exit status 0 is success. It is
  setuid and fails under `NoNewPrivileges=true`; comment this in
  `scripts/install-ubuntu.sh`.
- **macOS:** purego: `ODSessionDefaultSession`, `ODNodeCreateWithNodeType`
  (`kODNodeTypeAuthentication`), `ODNodeCopyRecord` (`kODRecordTypeUsers`),
  `ODRecordVerifyPassword`, with CoreFoundation strings and releases. Never
  `dscl -authonly`, which puts the password in process arguments.
- **Windows:** `LogonUserW` with `LOGON32_LOGON_NETWORK` through
  `golang.org/x/sys/windows`, closing the token.
- **Others:** report "unavailable" distinctly from "incorrect".
- Bound each verification with a timeout. Never log, audit, retain or return
  the password.
- Recovery when the account has no usable password: `tessera login` reads a
  `0600` token file, asks the running server over loopback for a single-use
  sign-in link valid for 2 minutes, and prints it. `tessera logout --all`
  revokes every sign-in.

## Sign-ins

- SQLite table via the next migration: ID, SHA-256 of the cookie secret,
  account, credential tag, kind (`remember` / `browser`), created, last seen,
  absolute expiry, created IP, user-agent summary, last IP, revoked time.
  The secret itself is never stored.
- Cookie `tessera_signin`: 32 random bytes, `HttpOnly`, `Path=/`,
  `SameSite=Strict`, `Secure` on HTTPS, persistent `Max-Age` only for "Keep
  me signed in".
- Lifetimes (`-signin-idle`, `-signin-max` set the remembered values):

  | Kind | Idle | Absolute |
  |---|---|---|
  | Keep me signed in | 30 days | 90 days |
  | Not remembered | 12 hours | 7 days |

- `last_seen` is written at most once an hour per sign-in; expired and revoked
  rows are removed periodically.

## Enforcement

- Public without sign-in: `/login`, `/login.css`, `/api/health`,
  `/local-https/` and `/api/host/https/ca`, `/assets/`,
  `/manifest.webmanifest`. Everything else needs a valid sign-in.
- Page navigations get `303` to `/login?next=<path>` (`next` must be a
  same-origin absolute path, else `/`). `/api/*` gets `401` JSON. WebSocket
  upgrades are refused with `401` before upgrading.
- `-auth=file`: `/api/users` returns only the signed-in account, and every
  user-scoped or workspace-scoped request must belong to it.
- `/browser-proxy/` keeps its sandboxed capability exception; strip the
  sign-in cookie from proxied requests.
- Passwords over plain HTTP from a non-loopback peer are refused unless
  `-allow-http-sign-in` is set, for links that are already encrypted, such as
  Tailscale or another VPN. The login page explains the HTTPS alternative.

## Login page

- Go-rendered `/login`, no `app.js`; works without JavaScript; BeOS dialog
  styling with light and dark schemes.
- "Sign in to Tessera", host name, account field (file mode) or the fixed
  account (system mode, as a hidden `autocomplete="username"` input),
  password (`autocomplete="current-password"`), "Keep me signed in on this
  device", Sign In. One generic error: "Incorrect name or password."
- `POST /logout` revokes the current sign-in and returns to `/login`.

## Throttling

Per client IP: no delay for 3 failures, then exponential backoff from 2 s to
a 15-minute cap, reset by success. At most 10 verifications per minute
overall, one at a time. Bounded IP table with idle expiry. `429` with
`Retry-After`.

## Phases

1. **File accounts end to end:** flags, credentials file and `tessera user`
   commands, sign-in table, cookie, login and logout, enforcement, per-account
   workspaces, throttling, client redirect on `401` and refused terminal
   sockets, Sign Out in the Deskbar menu, docs.
2. **System accounts:** `internal/sysauth` for Linux, macOS (purego) and
   Windows; `tessera login` recovery link and `tessera logout --all`.
3. **Polish and hardening:** in-app sign-in dialog that resumes without a
   reload; signed-in devices list with revoke; close live sockets with `4401`
   on revocation or expiry; audit events; `Host` allowlist (`-allowed-host`,
   `421`) against DNS rebinding.

## Tests

Credentials parsing, hashing, permissions and reload; CLI add/passwd/remove
with stdin passwords; sign-in creation, hashing, both expiries, throttled
`last_seen`, revocation, credential-tag invalidation, migration; public route
list, redirect vs `401`, `next` sanitization, WebSocket refusal, per-account
workspace checks, `-auth=off` unchanged; throttling schedule and bounds;
HTTP-from-remote refusal and `-allow-http-sign-in`; frontend `401` handling.
Run `gofmt`, `go vet ./...`, `go test ./...`, `node --test web/*.test.mjs`.

## Documentation

`README.md` (modes, setup, the not-isolation warning, keep the warning
against direct internet exposure), `ARCHITECTURE.md` (request pipeline,
sign-in store, credentials file), `CHANGELOG.md`.

## Phase 1 record (2026-10-16)

Implemented as planned, with these specifics:

- `internal/auth`: credentials file (parse, atomic `0600` write, ownership
  and permission check on Unix, reload on modification time or size change),
  argon2id hashing in PHC format, credential tags, and the throttle.
- `internal/store/signin.go` and migration `049_auth_sign_ins.sql`; times are
  Unix seconds so expiry comparisons are numeric.
- `internal/httpapi/auth.go`: gate, `/login` (Go template `login.html`),
  `/logout`. Unknown names are checked against a dummy hash so they take as
  long to reject as wrong passwords. `-auth=system` is rejected at startup
  until phase 2.
- Form posts and `Origin`: the site-wide `Referrer-Policy: no-referrer` makes
  browsers send `Origin: null` on form submissions, which the origin check
  refuses. Found in the browser run. The login page sends
  `Referrer-Policy: same-origin`; Sign Out uses `fetch` (CORS-mode requests
  keep the real origin) and answers `204` instead of redirecting.
- Client: `web/sign-in.mjs` wraps `fetch` so a `401` from `/api/*` sends the
  page to `/login?next=…`; an abnormal terminal socket close asks
  `/api/users` once so a refused upgrade does the same. With `-auth=file`
  the workspace opens the signed-in account directly, Switch User is hidden
  and Sign Out is added to the desktop menu and command palette.

Validation:

- Go: credentials, hashing, permissions, reload, throttle schedule and cap;
  gate (signed-out `401`/`303`, public paths, websocket refusal, login page
  attributes and headers, cookie flags, remembered `Max-Age`, per-account
  scoping, password change/removal/sign-out ending sign-ins, plain-HTTP
  refusal and override, throttling with `Retry-After`, cross-origin login
  refusal, `next` sanitization); `tessera user` commands and flag validation.
  `go vet ./...` and `go test ./...` pass.
- JavaScript: `web/sign-in.test.mjs`; full suite passes (550).
- Real server and headless Chrome: redirect to the login page, wrong
  password, sign-in to the account's workspace, a working terminal, Sign out
  from the desktop menu, and a page returning to the login screen (keeping
  its path) after its sign-in was ended elsewhere. No console errors.

Not yet verified: Safari on iPadOS/macOS (Keychain autofill, remembered
sign-ins across restarts), and live sockets still stay open after a sign-in
ends until they reconnect (phase 3).

## Phase 2 record (2026-10-16)

- `internal/sysauth`: `Account` and `Verify` (serialized, abandoned on context
  timeout). Linux runs `unix_chkpwd <user> nonull` with the password and a NUL
  on stdin; exit 7 is incorrect, anything else unavailable. macOS loads
  CoreFoundation and OpenDirectory with purego (`ODSessionCreate`,
  `ODNodeCreateWithNodeType` with `kODNodeTypeAuthentication`,
  `ODNodeCopyRecord`, `ODRecordVerifyPassword`); failures before the record
  lookup are unavailable, a refused password is incorrect. Windows calls
  `LogonUserW` (network logon) through a lazy `advapi32.dll` proc; logon,
  expiry, disabled and lockout errors are incorrect, others (including blank
  passwords' `ERROR_ACCOUNT_RESTRICTION`) unavailable.
- `-auth=system` uses the current account only; `-users` remains a picker.
  Unavailable checks are logged with their reason and the login page points
  to `tessera login`.
- Recovery: `auth-token` (32 random bytes, `0600`, same ownership checks as
  the credentials file) is created at startup in either mode.
  `POST /api/auth/recovery-link` and `POST /api/auth/revoke-all` require a
  direct loopback peer, no `Origin` or forwarding headers, and
  `Authorization: Bearer <token>`. Links are single-use, expire after 2
  minutes, at most 16 outstanding, and obey the plain-HTTP rule like
  passwords. `tessera login` (`-account` with `-auth=file`) and
  `tessera logout -all` call them.
- The Ubuntu unit now carries a comment that it must not set
  `NoNewPrivileges` or `RestrictSUIDSGID`.

Validation:

- Fake `unix_chkpwd` script: arguments never contain the password, stdin
  carries it NUL-terminated, exit 7 is incorrect, other exits, a missing
  helper and timeouts are unavailable.
- macOS live test (opt-in `TESSERA_SYSAUTH_LIVE=1`) with a wrong password:
  incorrect in ~120 ms, with and without cgo.
- Gate tests: fixed-account login page, incorrect vs unavailable, a submitted
  name cannot choose another account, `-users` roster after system sign-in,
  recovery link refusals (no/wrong token, remote, proxied, browser `Origin`),
  redemption, reuse, expiry, revoke-all, file-mode `-account`.
- Built and vetted for darwin (cgo on and off for the sign-in packages),
  linux, windows and freebsd. Full Go and JavaScript suites pass; the Ubuntu
  installer test passes.
- Real server on macOS with headless Chrome: system login page, wrong password
  through OpenDirectory, `tessera login` link sign-in into the existing
  single-user workspace, link reuse refused, `tessera logout -all` returning
  the page to the login screen.

Not yet verified: a correct macOS password (needs the account owner), real
Linux `unix_chkpwd` (no Linux host or VM available), and Windows.

## Phase 3 record (2026-10-16)

Decision: the `Host` allowlist is always on, including with sign-in off,
because installs without sign-in are the ones DNS rebinding can attack. IP
literals are always allowed, so only DNS names need `-allowed-host`.

- `host_allowlist.go`: allowed are IP literals, `localhost` and
  `*.localhost`, the machine hostname with and without `.local`, the Local
  HTTPS certificate's DNS names (re-read at most every 30 s), and
  `-allowed-host`. Others get `421` with the flag to add; each refused name is
  logged once (up to 256).
- `auth_watch.go`: `closeOnSignInEnd` registers terminal and VNC websockets
  under their sign-in. Logout, device revocation and revoke-all close them
  with `4401` via `WriteControl`; a ticker (30 s, only while sockets are open)
  re-validates watched sign-ins for expiry, removal or password change, and
  records `expired` audit events when auditing is on.
- `auth_devices.go`: `GET /api/auth/sign-ins` (own account only, current one
  marked, device label from the user agent, effective expiry), `DELETE
  /api/auth/sign-ins/{id}`, `DELETE /api/auth/sign-ins` for every device.
  Origin-checked.
- `POST /api/auth/login`: JSON sign-in for the dialog, sharing
  `attemptSignIn` with the form (transport rule, throttle, verification,
  cookie).
- Audit: the security handler passes a per-request note that the gate fills
  with the sign-in ID and outcomes such as `throttled`; `/login` posts,
  `/logout` and `/login/link` are now audited. Migration 050 adds
  `audit_events.sign_in_id`.
- Client: `SignInRecovery` wraps `fetch`; a `401` from the API (except the
  login call) opens one dialog for all waiting requests and retries them after
  sign-in, except stream bodies. A terminal closed with `4401` shows a
  "Signed out" badge and reconnects after sign-in. The dialog offers the
  sign-in page as a fallback. Settings gains Signed-in devices.

Validation:

- Go: allowlist matrix (IPv4/IPv6 literals, machine and `.local` names,
  certificate name, case and trailing dot, rebinding look-alikes); websocket
  closes with `4401` on sign-out and on a password change caught by the
  ticker; JSON sign-in incl. throttling; devices listing scoped to the
  account, cross-account revocation refused, single and everywhere revocation;
  audit sequence for failure, success and sign-out with IDs.
- JavaScript: one dialog for concurrent `401`s and retries, no intervention
  with sign-in off or for other paths, no replay of stream bodies.
- Full Go and JavaScript suites pass (552 JS).
- Real server with headless Chrome: `421` for an unknown name; sign-in,
  terminal, sign-in ended from outside, terminal badge and dialog over the
  intact workspace, wrong password in the dialog, sign-in, the same terminal
  reconnecting with its history; devices list in Settings; audit rows with
  sign-in IDs.

Follow-ups:

- The VNC pane closes on `4401` but does not yet reconnect after the dialog;
  reopen it after signing in.
- iPadOS Safari reports itself as macOS, so devices list iPads as
  "Safari on macOS".
- Not yet tried in Safari: Keychain autofill in the dialog and login page,
  remembered sign-ins across restarts.
