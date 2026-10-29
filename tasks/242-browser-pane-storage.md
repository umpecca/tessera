# Task 242: localStorage, sessionStorage and cookies in Browser panes

Status: built (2026-10-29); Go tests, and Chrome and WebKit end to end
through a scratch Tessera (see "Built"). Safari on iPad and DadGames still to
try.

## Request

Make `localStorage`, `sessionStorage` and cookies work for pages in a
Browser pane, without giving up the opaque origin that keeps them away from
Tessera's API. This replaces task 241 (a separate origin per dev server),
which is on hold over its extra ports and reachability. The proxy already
injects a bootstrap into every proxied HTML page and handles every request,
so it can provide all three itself, with the data kept by Tessera.

## Findings

### Today (from the code)

- Proxied pages are served under `/browser-proxy/<id>/…` on Tessera's
  origin, sandboxed without `allow-same-origin` by the pane's iframe and by
  the `Content-Security-Policy: sandbox …` the proxy adds
  (`internal/httpapi/browser_proxy.go`, `setBrowserProxyResponseHeaders`).
  `window.origin` is `"null"`, and `localStorage`, `sessionStorage` and
  `document.cookie` throw `SecurityError` (docs/browser-pane.md).
- The proxy strips `Cookie` from requests (it carries Tessera's sign-in
  cookie) and `Set-Cookie` from responses, so a dev server never sees a
  cookie.
- `rewriteBrowserHTML` injects the bootstrap right after `<head>`, before
  any page script. It captures `window.fetch` and patches `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource` and `window.open`.
- A proxy session (`POST /api/browser-proxy`, signed in) is made per
  address-bar navigation of a pane; reloads and in-page navigation keep it.
  The request carries only `target`. `SignedInAccount(ctx)` gives the account
  ("" with sign-in off). The session ID is the capability for
  `/browser-proxy/`, a public path.
- Proxied responses already send `Access-Control-Allow-Origin: null`.

### Feasibility test (2026-10-29)

Chrome 148 and Playwright WebKit 27.2, pages with the pane's sandbox flags and
the proxy's CSP sandbox header, plus a nested frame
(`sandbox="allow-scripts allow-same-origin"`, as DadGames' game frame).
The scratch test (`shimtest/run.mjs` in that session's scratchpad, not kept)
served the pages from Node and drove both browsers with `playwright-core`. Results were identical
in both engines and in the nested frame:

- `localStorage` and `sessionStorage` are configurable accessors on `window`
  itself, and `cookie` a configurable accessor on `Document.prototype`, so a
  script that runs first can replace them with `Object.defineProperty`.
- Page code sees the stand-ins everywhere checked: bare `localStorage`,
  `window.`, `self.`, `globalThis.`, inline and external module scripts.
  A `Proxy`-based storage passed `getItem`/`setItem`, property access
  (`localStorage.b = "x"`), `length`, `Object.keys`, `in` and
  `instanceof Storage` (true, by returning `Storage.prototype` from
  `getPrototypeOf`). `document.cookie` reads and writes worked, and
  `navigator.cookieEnabled` is true.
- A synchronous `XMLHttpRequest` from the sandboxed page to the server works
  in both, with `Access-Control-Allow-Origin: null`, so the bootstrap can
  load the page's data before page scripts run.
- Not tried: Safari on iPad (same engine, different build), and real-world
  libraries.

## Design (proposed)

### Where the data lives

- **localStorage:** per account and dev-server origin
  (`http://localhost:8080`), in SQLite. Unlike a browser, it is shared by
  every device signed in to the account (the Mac and the iPad see the same
  DadGames storage).
- **sessionStorage:** per Browser pane and dev-server origin, in memory on
  the host. It survives reloads, in-pane navigation and address-bar
  navigation within the same origin, as a browser tab does, and is dropped
  when the pane closes, after 24 hours unused, or when Tessera restarts.
- **Cookies:** a jar per account and dev-server origin, in SQLite, so
  persistent cookies survive restarts; session cookies (no `Expires` or
  `Max-Age`) are dropped when Tessera restarts.
- Quota: 5 MiB per origin for each of `localStorage` and `sessionStorage`,
  counted as browsers do (UTF-16 code units of keys plus values); 4 KiB per
  cookie and 180 cookies per origin.

### Host side

1. `POST /api/browser-proxy` also takes the pane's ID. The session records
   account, pane and target origin.
2. A new public prefix, `/browser-proxy-state/<session id>`, beside
   `/browser-proxy/` (so it can never collide with a dev server's path):
   - `GET` returns the page's snapshot: its `localStorage`,
     `sessionStorage`, and the non-`HttpOnly` cookies matching the document's
     path (`?path=`), as JSON.
   - `POST` applies a batch of operations in order: `local`/`session` `set`,
     `remove` and `clear`, and `cookie` with a raw `document.cookie` string.
     The body is `text/plain` JSON, so no CORS preflight is needed. It answers
     with the updated script-visible cookies for the posted path, and refuses
     a batch over quota with 413, naming the store.
3. **Cookie jar** (new, about 150 lines; Go's `net/http/cookiejar` neither
   reports `HttpOnly` nor can be saved): host-only cookies for the target
   host, RFC 6265 path matching, `Expires`/`Max-Age`, `HttpOnly`, `Secure`
   (kept even over `http://`, as browsers do for `localhost`), `SameSite`
   stored but not enforced. `Domain` other than the target host is refused.
   A `document.cookie` write can't set or replace an `HttpOnly` cookie.
4. **Requests:** the proxy keeps stripping the browser's `Cookie` and sends
   the jar's cookies for the request URL instead. This includes `fetch`,
   XHR, `EventSource` and WebSocket upgrades.
5. **Responses:** `Set-Cookie` goes into the jar and stays out of the
   response, as now. When it changes a script-visible cookie, the response
   carries `X-Tessera-Cookies` (exposed through
   `Access-Control-Expose-Headers`) with the updated script-visible cookies
   for the request's path, so the open page's copy stays current.
6. Storage writes for an origin are serialized; operations apply in arrival
   order.

### Page side (the injected bootstrap)

1. First, a synchronous `GET` of the snapshot (using the captured, unpatched
   `XMLHttpRequest`). If it fails, the stand-ins start empty and the page
   carries on.
2. `Object.defineProperty` replaces `window.localStorage`,
   `window.sessionStorage` (configurable, so a page or library can still
   redefine them) and `document.cookie`. The storage stand-ins are `Proxy`
   objects implementing the `Storage` interface, with `Storage.prototype` as
   their prototype. They throw `QuotaExceededError` as a `DOMException`
   when a write would go over the quota.
3. Writes change the page's copy at once and are sent in a batch at the end
   of the current task (a microtask), with `fetch(…, { keepalive: true })`,
   and once more on `pagehide`.
4. The patched `fetch` and `XMLHttpRequest` read `X-Tessera-Cookies` from
   proxied responses and update the `document.cookie` copy.
5. `document.cookie` reads return the copy, formatted as browsers do
   (`a=1; b=2`, longest path first).

### Pane

- The Browser pane's toolbar gets **Clear site data**, which clears
  `localStorage`, `sessionStorage` and cookies for the pane's dev server
  (`DELETE /api/browser-proxy/<id>/state`) and reloads it.

## Limits (to document)

- **Write-then-navigate race.** A write made just before a navigation is sent
  before the next page is requested but could, rarely, be applied after the
  next page has read its snapshot. Synchronous writes would close the gap but
  make frequent writers (games saving every frame) stutter.
- **No `storage` events between documents.** Each sandboxed document is its
  own opaque origin, so nothing is shared to deliver them. A later step could
  relay them through the Tessera page.
- **Not covered:** IndexedDB, Cache Storage, service workers, the Storage
  Access API, `navigator.storage`, and `cookieStore`.
- `SameSite` isn't enforced, and feature detection that probes storage sees
  the stand-ins.
- Data is shared across the account's devices (see above), not per browser.

## Decisions to confirm before building

1. **Per account (proposed) or per sign-in (per device) for localStorage and
   cookies.** Per account means DadGames, or a dev app's login, is the same on
   the Mac and the iPad; per sign-in is closer to a browser but is lost on
   sign-out.
2. **Snapshot by synchronous request (proposed) or embedded in the HTML.**
   Embedding saves a round trip but makes every proxied HTML response
   uncacheable and as large as the storage.
3. **Whether Clear site data is enough management**, or Settings should list
   each dev server's stored data with sizes.

## Plan

1. `migrations/`: `browser_storage (account, origin, key, value)` and
   `browser_cookies (account, origin, name, path, value, expires, secure,
   http_only, same_site, created)`. `internal/store`: get, apply operations,
   clear.
2. `internal/httpapi`: cookie jar (`browser_cookies.go`) with tests;
   sessionStorage map with expiry; `/browser-proxy-state/` handler; jar use in
   the proxy's `Rewrite` and `ModifyResponse`; `publicPath` entry; pane ID in
   the create request.
3. Bootstrap in `rewriteBrowserHTML`: snapshot load, stand-ins, write
   batching, cookie header updates in the patched `fetch` and XHR. Keep it
   readable: move the bootstrap to an embedded `.js` file if it grows past
   the current one-liners.
4. `web/app.js`: pane ID in `POST /api/browser-proxy`, Clear site data
   button.
5. Docs: `docs/browser-pane.md` (replace the "throw" bullets with what works,
   the limits, Clear site data).

## Tests

- Go: jar parsing and matching (path, expiry, `Max-Age=0` deletes,
  `HttpOnly` hidden from and unsettable by script, foreign `Domain` refused);
  jar cookies on proxied requests, including WebSocket upgrades; `Set-Cookie`
  kept out of responses and `X-Tessera-Cookies` sent when needed; state
  endpoint snapshot, ordered batches, quotas (413), per-account and per-origin
  isolation, sessionStorage per pane and expiry; unknown session IDs refused;
  the browser's own `Cookie` (Tessera's sign-in) never forwarded.
- Bootstrap in real browsers (Chrome, Safari on macOS and iPad), extending
  the scratch test: values survive reload, navigation and Tessera restart;
  sessionStorage survives reload but not closing the pane; a dev-server login
  with an `HttpOnly` session cookie stays signed in; `document.cookie` sees
  a cookie set by a `fetch` response; quota error; nested frames;
  DadGames' channel guide remembers its place.

## Out of scope

- IndexedDB and service workers (see Limits); the separate-origin approach
  stays in task 241.
- Cookies or storage for anything but the pane's own dev server origin.

## Built (2026-10-29)

Decisions taken as proposed: per account, a blocking snapshot request, and
Clear site data only.

- `migrations/056_browser_site_data.sql`, `internal/store/browser_site_data.go`:
  `browser_storage` (with a UTF-16 `size` column for the quota) and
  `browser_cookies`; batches apply all or none.
- `internal/httpapi/browser_cookies.go`: the jar. Saves only persistent
  cookies, newest save wins.
- `internal/httpapi/browser_site_data.go`: per-site jars, sessionStorage
  (and localStorage without a store) in memory, `/browser-proxy-state/<id>`
  (GET snapshot or `part=cookies`, POST batches, 413 over quota),
  `DELETE /api/browser-proxy/<id>/site-data`.
- `internal/httpapi/browser_site_data.js`: the stand-ins, injected at the
  start of the existing bootstrap `<script>`. Cookie changes from responses
  are signalled with `X-Tessera-Cookies: stale` rather than carried, so the
  next `document.cookie` read fetches them (blocking, after sending any
  waiting writes).
- `web/app.js`: the pane's ID in `POST /api/browser-proxy`; the ⌫ Clear site
  data button.
- Not done: dropping a pane's sessionStorage when the pane closes (it
  expires after a day unused instead); `storage` events.

End to end (scratch Tessera with `-auth off`, a Node dev server, Chrome 148
and Playwright WebKit 27.2, the pane's sandbox flags): localStorage counted
on across visits, panes, both browsers and a Tessera restart;
sessionStorage was per pane and gone after the restart; `document.cookie`
saw its own write and, after `fetch("/login")`, the non-`HttpOnly` cookie
only, while the server got all three; a 6 MiB `setItem` threw
`QuotaExceededError`.
