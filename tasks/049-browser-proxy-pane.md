# Task 049: Browser proxy pane

Status: complete

Add a Browser pane that displays web development servers running on the
Tessera host through Tessera's existing HTTP listener.

## Requirements

- Add Browser as a pane type in the window menu and command palette.
- Provide an address field, Back, Forward, Reload, and Open Externally controls.
- Accept addresses such as `localhost:5000`, normalize them to HTTP URLs, and
  persist the current logical URL with the pane.
- Proxy browser-pane HTTP requests through a pane-scoped path on Tessera's
  existing listener; do not open additional listeners or expose the target
  development-server port.
- Permit only loopback HTTP and HTTPS targets, validating redirects and dialed
  addresses to prevent SSRF and DNS rebinding.
- Support ordinary relative and root-relative assets, redirects, forms, fetch,
  and WebSocket upgrades used by common local development servers.
- Isolate proxied content from Tessera's parent page and APIs with a sandboxed
  iframe and proxy-specific request authorization.
- Display useful loading and connection errors inside the Browser pane.
- Document that service workers, strict origin assumptions, complex
  authentication, and unusual URL construction may require application-side
  configuration.

## Verification

- Add focused proxy tests for target validation, routing and rewriting,
  redirects, forbidden destinations, and WebSocket forwarding.
- Add frontend tests for address normalization and proxy URL construction.
- Smoke-test a representative local development page through a Browser pane.
- Run all frontend tests, `go test ./...`, and `git diff --check`.

## Completion

- Added the persisted Browser pane, toolbar, sandboxed iframe, and loopback-only
  address normalization.
- Added capability-scoped HTTP/HTTPS and WebSocket proxy sessions with dial-time
  loopback validation, redirect checks, cookie isolation, and development-page
  URL rewriting.
- Added frontend, store, migration, proxy, redirect, and WebSocket coverage.
- Verified the live pane against a module-based page on `localhost:5000`, then
  ran all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.
