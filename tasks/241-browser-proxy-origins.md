# Task 241: A separate origin for Browser pane pages

Status: WONT DO FOR NOW (2026-10-29). Scoped but not started: the extra
ports, their reachability (see "Reachability") and the fallback modes add
more moving parts than storage in the Browser pane is worth today. Pages
there keep their opaque origin; apps should fall back when storage throws.

## Request

Give pages in a Browser pane working `localStorage`, `sessionStorage`,
IndexedDB, cookies and service workers, by serving them from an origin of
their own instead of Tessera's, so the frame no longer needs an opaque
origin. Prompted by DadGames (task 230) in a Browser pane: its games can't
save anything locally, and a sandboxed page can't use gamepads without
delegation (the gamepad part was fixed separately with `allow="gamepad *"`
on the pane's iframe).

## Findings (2026-10-29, from the code)

- **Why the origin is opaque today.** Proxied pages are served from
  Tessera's own origin under `/browser-proxy/<id>/…`
  (`internal/httpapi/browser_proxy.go`). Without a sandbox they would be
  same-origin with Tessera and could drive its API. So the pane's iframe has
  `sandbox="allow-scripts allow-forms allow-modals allow-popups
  allow-downloads"` without `allow-same-origin` (`web/app.js`, browser pane
  setup), and every proxied response carries a `Content-Security-Policy:
  sandbox …` matching it (`setBrowserProxyResponseHeaders`), so a page opened
  in a new tab is opaque too. An opaque origin has no storage, no cookies, no
  service workers, and permissions such as gamepads only by delegation.
- **The path prefix needs a lot of extra machinery.** Because every page
  lives under `/browser-proxy/<id>/`, the proxy rewrites root-relative
  `src`/`href`/`action`/`poster`, CSS `url(/…)` and JS `import "/…"`; injects
  a bootstrap that patches `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource` and `window.open` and intercepts link clicks and form
  submits; rewrites `Location` headers; and has an escape page for script
  navigations to Tessera's own paths (`escapedBrowserNavigation`). `srcset`
  and URLs built in JS are still missed (docs/browser-pane.md). On an origin
  of its own, mapped one-to-one to a dev server, paths need no rewriting at
  all.
- **Access today is a capability.** `/browser-proxy/` is a public path
  (`publicPath` in `internal/httpapi/auth.go`): the 24-byte session ID in the
  URL is the credential, and `Cookie`/`Set-Cookie` are stripped both ways.
- **Tessera's own API refuses other origins, ports included.**
  `requestOriginAllowed` (`internal/httpapi/security.go`) compares the
  `Origin` header's scheme, host *and port* with the request's, for every
  state-changing `/api/` request, sign-in, sign-out and settings. The
  terminal, RDP proxy and kept-RDP WebSockets check the origin the same way.
  Cross-origin GETs can't read responses (no CORS headers), and sign-out is
  POST-only. So a page on another port of the same host can't drive Tessera.
- **But a different port is the same *site*.** Cookies ignore ports, so:
  - Tessera's sign-in cookie (`HttpOnly`, `SameSite=Strict`) is sent to
    every port on the host, including the proxy's. The proxy already strips
    `Cookie` before forwarding, and `HttpOnly` keeps it from page script.
  - A proxied page can set `document.cookie` for the host, and Tessera's
    port receives it: *cookie tossing*. A page could shadow the sign-in
    cookie with a more specific `Path` (signing the browser out, or into an
    account whose secret it holds). `__Host-` doesn't prevent it, since
    another HTTPS port on the same host can set those too. The pages are the
    user's own dev servers, so this is accepted (see Decision 6), with a
    `Sec-Fetch-Site` guard as defense in depth.
- **Tessera's CSP would block the frame.** `securityCSP` has no `frame-src`,
  so it falls back to `default-src 'self'`, and a frame on another port is
  refused. It needs `frame-src 'self' <scheme>://<host>:*` (or the exact
  proxy ports).
- **The Local HTTPS certificate covers any port.** Its SANs are host names
  and IPs (`internal/localhttps`), so proxy listeners on the same host can
  serve TLS with the same certificate, and an enrolled iPad already trusts it.
- **Listeners.** `internal/server/server.go` starts one HTTP listener
  (default `127.0.0.1:7331`) and, with Local HTTPS, a separate HTTPS one;
  `ReloadLocalHTTPS` restarts them. A page served over HTTPS can only frame
  HTTPS, so the proxy must offer the scheme the Tessera page uses.
- **Sign-in can be off** (`AuthOff`), and then all of Tessera is open to
  whoever can reach it. Proxy ports would be open on the same terms.

## Design (proposed)

1. **One origin per dev server.** Tessera gives each proxied target
   (`scheme://host:port` on loopback) a proxy port of its own, from a range
   (default 7400–7499, a setting). The proxy origin is then
   `<scheme>://<the host the browser used for Tessera>:<proxy port>`, and it
   passes requests to the target unchanged, with no path prefix. Each dev
   server gets its own storage, just as it does on `localhost:<port>`.
2. **Stable ports.** The target→port mapping is stored in SQLite, so a dev
   server keeps its port, and its storage, across Tessera restarts. If the
   port is busy at startup, the target gets the next free one and its stored
   data stays behind on the old origin. The pane says so once.
3. **Listeners open on demand.** A proxy port's listener starts when a pane
   first opens its target and stays up while Tessera runs (closing on idle is
   a later refinement). It binds to the same interface as Tessera's HTTP
   listener, so a LAN-reachable Tessera has LAN-reachable proxy ports, and a
   loopback-only one doesn't. Local HTTPS reloads restart them.
4. **HTTP and HTTPS on the same port.** Each proxy listener peeks at a
   connection's first byte: `0x16` (a TLS handshake) is served with the Local
   HTTPS certificate, anything else as plain HTTP. The pane frames the proxy
   with the scheme of the page it is on. Without Local HTTPS it is HTTP only.
5. **Access by Tessera sign-in.** The proxy listener accepts a request only
   with a valid Tessera sign-in cookie, which the browser sends because
   cookies are host-wide and the frame is same-site. This replaces the
   capability ID in the path. With sign-in off, proxy ports are open like the
   rest of Tessera. A request without a valid sign-in gets a small page
   saying to open it from Tessera, not a redirect to `/login`, which is on
   another origin.
6. **Cookies pass through, except Tessera's.** The proxy forwards the
   page's cookies minus Tessera's own (`signInCookie` and any other Tessera
   cookie name), and passes `Set-Cookie` through except for those names. As
   with `localhost` natively, cookies are shared by every port on the host:
   across dev servers, and visible to Tessera's port. Tessera ignores cookies
   it doesn't own. Defense in depth: Tessera's own listeners refuse
   state-changing requests and WebSocket upgrades whose `Sec-Fetch-Site` is
   `same-site` (Tessera's own pages are `same-origin`).
7. **Much less rewriting.** Removed: the path prefix, HTML/CSS/JS URL
   rewriting, the `fetch`/XHR/`WebSocket`/`EventSource`/`window.open`
   patches, link and submit interception, and the escape page. Kept: a small
   injected bootstrap for what the pane needs (location reports, back,
   forward and reload messages, the window-shortcut key relay, the
   middle-button draw relay), and rewriting of absolute URLs to the target's
   own origin (`http://localhost:5000/…`) to the proxy origin, in `Location`
   headers and in the bootstrap's link handling. The 32 MB rewrite limit then
   applies only to HTML, to inject the bootstrap.
8. **The frame gets its real origin.** The iframe's sandbox adds
   `allow-same-origin` (it stays sandboxed for top navigation), and the
   proxy's response CSP drops `sandbox`. The rest of that CSP stays as is.
   Proxy responses send `frame-ancestors` listing Tessera's origins, so
   other sites can't frame a dev server through Tessera. Tessera's own CSP
   gains `frame-src` for the proxy origins.
9. **API change.** `POST /api/browser-proxy` returns the proxy origin
   (`origin`) and the frame URL (`url`) instead of `path`. Sessions as such go
   away: the mapping is per target. `DELETE` is no longer needed by panes;
   keep it as a no-op for a release.

## Reachability

Every device Tessera is used from must reach each proxy port directly, and
many setups don't allow that:

| How Tessera is reached | Proxy ports reachable? |
|---|---|
| LAN by IP or name, macOS or Windows host | Yes: their firewalls allow per app, so all of Tessera's ports once it is allowed |
| LAN, Linux host with ufw or firewalld | Only if the range is opened |
| Tailscale by 100.x address or MagicDNS | Yes, unless ACLs restrict ports |
| Tailscale Serve or Funnel, Cloudflare Tunnel, ngrok, nginx or Caddy in front | No: only the configured ports are exposed |
| SSH `-L` of one port, Docker publishing one port | No, unless the range is forwarded too |
| Router port forward from the internet | Only if the range is forwarded |

An origin is scheme + host + port, so on a single port, separate origins
need separate host names. The design therefore has three parts:

1. **Probe, then fall back.** Before framing a proxy origin, the pane loads
   `/.tessera-proxy/ping` from it in a hidden frame (which answers with a
   `postMessage`; a 3 s timeout is a failure). If it fails, the pane uses
   today's path-based proxy on Tessera's own origin, sandboxed and without
   storage, and shows a one-line note naming the port to open. The result is
   remembered per origin for the page's lifetime, so the probe runs once.
2. **Settings show it.** The Browser pane section of Settings lists the
   port range, the ports in use with their targets, and which answered from
   this browser.
3. **Host-name template for single-port setups.** A setting such as
   `https://{port}.dev.example.com` makes the proxy origin for a target on
   port 5000 `https://5000.dev.example.com`, served on Tessera's own port and
   routed by `Host` header, so a tunnel or reverse proxy needs only a
   wildcard DNS name (and a wildcard certificate on HTTPS) pointing at
   Tessera. With a template set, no proxy ports are opened. Cookies are then
   split by host, so the sign-in cookie isn't sent to the proxy hosts: access
   needs a ticket instead (the pane's frame URL carries a one-time ticket from
   `POST /api/browser-proxy` that the proxy host swaps for its own cookie).

## Decisions to confirm before building

1. **Per-target ports (recommended) or one shared proxy port.** A shared
   port is simpler (one listener) but keeps the path prefix and all its
   rewriting, and every dev server shares one origin's storage, so two apps
   using the same `localStorage` keys clash.
2. **Reachability handling** as in "Reachability" above: the probe and
   fallback, and whether the host-name template is in the first version or
   follows.
3. **Port range default.** 7400–7499 next to Tessera's 7331, or Tessera's
   port + 1 upward.
4. **Whether Decision 6's `Sec-Fetch-Site` rule is acceptable.** It refuses
   state changes from any same-site page, including unrelated apps on other
   ports of the same host, which Tessera never relies on today.

## Plan

1. `internal/httpapi`: proxy listener manager (allocation, SQLite mapping,
   lazy start, TLS sniffing), proxy handler (sign-in check, cookie filtering,
   `Location` rewriting, bootstrap injection), proxy-only `/.tessera-proxy/`
   paths (ping, not-signed-in page, ticket exchange for host-name mode).
   Proxy listeners use their own handler:
   none of Tessera's routes are reachable on them.
2. `internal/store`: `browser_proxy_ports` table (target, port).
3. `internal/server`: start and stop proxy listeners with the main ones,
   including `ReloadLocalHTTPS`.
4. Security headers: `frame-src` in Tessera's CSP; the `Sec-Fetch-Site`
   rule; proxy `frame-ancestors`.
5. `web/app.js`: frame the returned `url`, add `allow-same-origin`, keep
   `allow="gamepad *"`; location, back, forward, reload and key relay as now
   (messages now come from a real origin: check `event.origin` against the
   proxy origin as well as `event.source`).
6. Delete the rewriting and escape code once the compatible mode (Decision
   2) is settled; if kept, it stays behind the mode switch.
7. Docs: `docs/browser-pane.md` (what works now, cookies shared across ports
   as on localhost, ports needing to be reachable from other devices),
   `docs/workspace.md`.

## Tests

- Go: port allocation and persistence, busy-port fallback; TLS and plain
  HTTP on one port; proxy refuses requests without a sign-in (and allows
  with sign-in off); Tessera cookies stripped and refused in `Set-Cookie`;
  `Location` rewriting; Tessera routes unreachable on proxy ports; POSTs and
  WebSocket upgrades to Tessera's API from a proxy origin refused (origin
  check and `Sec-Fetch-Site`); CSP `frame-src` present.
- Web: the pane builds the frame from `url`; messages from other origins
  ignored; a failed probe falls back to the path-based proxy with the note.
- Reachability: the fallback through an SSH forward of only Tessera's port;
  host-name mode behind Caddy with a wildcard name.
- Real browsers (Chrome, Safari on macOS and iPad, over HTTP and Local
  HTTPS): `localStorage` and IndexedDB persist across reload and Tessera
  restart; separate dev servers don't share storage; a service worker
  registers; Vite HMR WebSocket works; root-relative script navigation stays
  in the app; gamepad works; DadGames end to end, including its inner game
  iframe.

## Out of scope

- Per-user isolation of a dev server's storage: storage lives in the
  browser, so two Tessera users on one browser share it, as they would on
  `localhost`.
- Proxying non-loopback targets (unchanged: loopback only).
