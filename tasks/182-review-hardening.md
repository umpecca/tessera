# Task 182: Review hardening

Status: complete

## Request

Review the project for further issues and fix what is found.

## Changes

- **VNC targets with bare IPv6 addresses.** Go 1.26's `url.Parse` accepts
  `vnc://2001:db8::1` as host `2001:db8:` port `1`, so `normalizeVNCTarget`
  silently produced a meaningless target and `TestNormalizeVNCTarget` failed.
  IPv6 targets must now be bracketed (`[2001:db8::1]:5900`).
- **Browser proxy pages outside the pane iframe.** The pane iframe is sandboxed
  without `allow-same-origin`, but a proxied page opened directly (for example
  "Open link in new tab" on a rewritten link) ran unsandboxed on Tessera's
  origin and could drive its API, terminals included. Proxied responses now
  carry a CSP `sandbox` directive mirroring the iframe's flags.
- **Browser proxy error page** now HTML-escapes the target host and error text.
- **Self-update integrity.** The updater installed whatever bytes it
  downloaded. It now verifies the `sha256:` digest GitHub publishes for each
  release asset when present (older releases without one still update), and
  bounds the download to the advertised size, or 512 MiB when none is given.

## Noted, not changed

- DNS rebinding remains open until task 181 adds a Host allowlist.
- Updates are offered whenever the latest tag differs from the running
  version, so a locally built newer version would be "updated" downward.
- The terminal websocket sets no read limit.
- `ResizeWithMetrics` resizes the PTY before the core; a core failure leaves
  them disagreeing.

## Validation

- `go vet` and `go test -race ./...` pass.
- New tests: proxy responses keep the sandbox without `allow-same-origin`;
  matching and mismatched release digests (mismatch keeps the old binary and
  leaves no `.new` file).
- JavaScript tests were run later (task 187): all 562 pass.
