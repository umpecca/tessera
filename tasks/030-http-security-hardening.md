# Task 030 — HTTP security hardening

Status: complete

Implemented with a middleware around the complete application handler, strict
single-hop proxy parsing, exact effective-origin checks for mutations and
Terminal WebSockets, host-specific CSP WebSocket sources, HTTPS-only HSTS, a
bounded token-bucket limiter, request IDs, and opt-in redacted SQLite audit
events. Audit persistence is disabled by default and enabled with `-audit-log`.
Localhost, direct DNS, literal IPv4/IPv6 intranet access, and origin-less local
HTTP clients remain supported. Migration `028_audit_events.sql` adds the audit
schema and retention is enforced during append operations. The CSP grants the
narrow `wasm-unsafe-eval` capability required by the bundled Terminal renderer
without granting general JavaScript `unsafe-eval`. Its `connect-src` also
allows self-contained `data:` fetches so `ghostty-web` can load its embedded
WASM instead of falling through to a nonexistent server asset.

Add a cohesive HTTP hardening layer for Tessera before authentication and
public hosting are introduced. Preserve the current zero-configuration
localhost workflow while making behavior explicit and restrictive when the
server is placed behind a proxy or exposed on a network.

## Scope

### CSRF and origin protection

- Reject cross-origin state-changing API requests (`POST`, `PUT`, `PATCH`, and
  `DELETE`) before they reach handlers.
- Validate `Origin` against the effective request origin. Only use forwarded
  host and scheme information when the direct peer is an explicitly trusted
  proxy.
- Allow requests without an `Origin` so non-browser local clients continue to
  work; authentication work must add a session-bound CSRF token before Tessera
  is documented as safe for public hosting.
- Keep terminal WebSocket origin validation and apply the same effective-origin
  rules to it.

### Explicit proxy trust

- Add a repeatable/comma-separated `-trusted-proxy` option accepting individual
  IP addresses or CIDR ranges.
- Ignore `Forwarded` and `X-Forwarded-*` headers from all other peers.
- For trusted peers, use only a single, validated forwarded client address,
  host, and scheme; fail closed on malformed or ambiguous values.
- Use the derived client address consistently for rate limiting and audit
  records.

### Security response headers

- Add `Content-Security-Policy`, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, and frame-embedding protection to
  application responses.
- Emit HSTS only when the effective request is HTTPS, with a conservative
  initial lifetime and no `includeSubDomains` or preload directive.
- Ensure headers remain compatible with the embedded CodeMirror, terminal,
  WebSocket, SSE, audio, and background-image behavior.

### Rate limits

- Add a bounded in-memory per-client-IP limiter with configurable request rate
  and burst flags and safe defaults.
- Apply it to `/api/` and WebSocket handshake requests without interrupting an
  established stream or terminal connection.
- Return `429 Too Many Requests` with `Retry-After` and JSON for API requests.
- Bound and periodically remove inactive limiter entries.

### Persistent audit log

- Add the next append-only SQLite migration for audit events.
- Record state-changing API requests and terminal connection attempts with UTC
  timestamp, request ID, derived client IP, method, route path, response status,
  outcome, and duration.
- Do not record query strings, request/response bodies, command text, file
  contents, cookies, tokens, or proxy headers.
- Log persistence failures through the server logger without changing the
  request result.
- Add a bounded retention policy so audit data cannot grow indefinitely.
- Keep audit persistence disabled by default and require the explicit
  `-audit-log` toggle to enable it.
- Do not expose audit records through a new HTTP endpoint in this task; access
  control does not exist yet.

## Configuration

Add server options and matching CLI flags for trusted proxies, rate, burst,
audit enablement, and audit retention. Defaults must require no changes for the
existing `127.0.0.1:7331` workflow.

## Tests

- Cover same-origin, cross-origin, missing-origin, and trusted/untrusted proxy
  cases.
- Cover security headers on ordinary, API, streaming, and upgrade responses.
- Cover limiter isolation, rejection, cleanup, forwarded client addresses, and
  disabled/configured modes.
- Cover audit schema migration, redaction, success/failure status capture, and
  retention.
- Run `gofmt`, `go test ./...`, `go vet ./...`, `node --check web/app.js`, and
  `node --test web/text-editor-language.test.mjs`.

## Documentation

Update `README.md`, `ARCHITECTURE.md`, and `CHANGELOG.md` with the flags,
behavior, limitations, and the explicit statement that these controls do not
replace authentication, authorization, filesystem roots, or TLS.
