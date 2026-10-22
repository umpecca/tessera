# Task 230: Browser proxy subpaths, redirects and navigation

Status: complete in Chrome (DadGames end to end and Safari on macOS and iPad pending)

## Request

Fix the Browser pane problems found while embedding DadGames (a Go game portal
on `localhost:8080`) in a Browser pane in Safari. Selecting a profile left the
pane blank white; once DadGames was changed to work around that, its games
still failed to load. Five items, all in `internal/httpapi/browser_proxy.go`
unless noted: three bugs, one design decision and one documentation gap.

## Findings

Reproduced against a scratch Tessera (`-addr 127.0.0.1:7399`, sign-in off)
with a proxy session from `POST /api/browser-proxy`, loaded in headless Chrome
over CDP inside an iframe with the pane's sandbox flags
(`allow-scripts allow-forms allow-modals allow-popups allow-downloads`).

### 1. Injected `<base href>` ignores the page's directory (bug, confirmed)

`rewriteBrowserHTML` injects `<base href="{prefix}/">` into every HTML
response. A page at `{prefix}/games/snake/index.html` referencing
`<script src="game.js">` requested `{prefix}/game.js` (upstream `GET /game.js`
404) instead of `{prefix}/games/snake/game.js`. Every relative URL on a page
outside the site root resolves against the root: scripts, images, CSS, and
URLs resolved at runtime (Phaser's `this.load.image('assets/x.png')`, `new
URL(x, document.baseURI)`).

The base isn't needed at all. `browserProxyRequest` returns 404 when there is
no `/` after the session id, so every proxied document already has a URL of
the form `{prefix}/…/page.html`, and the browser resolves relative URLs
against it correctly. A per-directory base would still break two things that
removing it fixes:

- Fragment links: with any base, `<a href="#section">` on `/a/b/page.html`
  resolves to `{prefix}/a/b/#section` and loads the directory index instead of
  scrolling (today it goes to the site root).
- A page's own `<base href>`: the injected tag comes first, and the first
  `<base>` wins, so the page's is ignored.

Fix: drop the injected `<base>`. Keep the existing root-relative attribute
rewrites; they're independent of the base. If a reason for the base turns up,
set it to the full request path (`prefix` + `response.Request.URL.Path`),
which behaves the same as no base, not to the directory.

Related, same function: the bootstrap goes in only after a literal `<head>`.
`<head lang="en">`, or a page with no `<head>` tag (valid HTML), falls through
to `append(bootstrap, body...)`, putting a `<script>` before `<!doctype html>`
and switching the page into quirks mode. That changes how canvases and layouts
render and may account for some of the games failing. Match `<head[\s>]` and
insert after it; with no head, insert after the doctype and `<html…>` tag.

### 2. Relative redirects resolve against the session's start URL (bug, confirmed)

Line ~271: `resolved, err := target.Parse(location)`. `target` is the URL the
session was created with, not the URL that was requested. Go's
`http.FileServer` answers `/games/snake/index.html?p=1` with
`301 Location: ./?p=1`; the proxy rewrote it to `{prefix}/?p=1` (site root)
instead of `{prefix}/games/snake/?p=1`.

Fix: resolve with `response.Request.URL.Parse(location)` and keep the
`sameURLOrigin(resolved, target)` check. `response.Request.URL` is the
outgoing upstream URL (target scheme and host, prefix already stripped), so
this resolves against the right path. Also keep `resolved.Fragment` when
rewriting `Location`.

### 3. Script navigation escapes the proxy, causing the blank white pane (bug, from code; matches the symptom)

The injected bootstrap rewrites `fetch`, `XMLHttpRequest.open`, `WebSocket`,
`EventSource`, link clicks and form submits, but not `location.href = '/…'`,
`location.assign`, `location.replace` or `window.open`. The click handler also
skips links with a `target` other than `_self`, so `target="_blank"` links
escape too. A root-relative script navigation loads Tessera's own path inside
the pane. Tessera responds with `X-Frame-Options: DENY`, which Safari renders
as a blank white frame with no message. This was DadGames' symptom: after
`PUT /api/session` succeeded, its `location.href = '/'` navigated the pane to
Tessera's `/`.

`location.href` can't be patched (unforgeable property), so:

- Patch `window.open` in the bootstrap to pass its URL through `proxyURL`, and
  rewrite `target="_blank"` (and other non-`_self` target) link URLs through
  `proxyURL` too, rather than skipping them. Neither depends on the Navigation
  API.
- ~~Intercept in the bootstrap with the Navigation API~~. Doesn't work in any
  browser: an opaque-origin document has the API's entries and events
  disabled (in the sandboxed frame Chrome reports `navigation.entries()`
  empty and `currentEntry` null, and no `navigate` event fires). Replaced by
  the relay in the next point.
- Make the escape diagnosable either way: when a request for a non-proxy
  Tessera path arrives with `Sec-Fetch-Dest: iframe`, answer with a small
  frameable page saying the page navigated outside the browser proxy (and to
  which path) instead of the `DENY` white frame. Don't serve the app itself
  framed. The page must be static: no app content, nothing reflected beyond
  the HTML-escaped path, and `frame-ancestors 'self'` rather than no framing
  protection. A "back" link (`history.back()`) is useful. `Sec-Fetch-Dest` is
  set by the browser, so a hostile page can't fake it.
- Send the frame back (added during implementation): the escape page posts
  `{type: "tessera-browser-escape", path}` to its parent, and the app, for a
  message from one of its Browser frames, replaces the frame's location with
  `/browser-proxy/{session}{path}`. This is the actual fix for script
  navigation, in every browser; the explanatory text only stays up if the
  relay doesn't run.

Not pursued: having the server redirect the escaped request back into the
proxy. The sandboxed document has an opaque origin, so the request counts as
cross-origin and `Referer` is cut down to the origin, losing the session id.
Getting it back would need `Referrer-Policy: unsafe-url`, which would leak the
session token to any external site a proxied page links to.

### 4. Cookies are stripped in both directions (design decision)

`request.Out.Header.Del("Cookie")` (line ~218) and
`response.Header.Del("Set-Cookie")` (line ~269) mean no proxied site can keep
a cookie session. DadGames no longer needs cookies (it now carries the player
in the URL and a request header), so this is only for other apps.

Option: a cookie jar per proxy session, kept on the server, using
`net/http/cookiejar` (handles Path, Expires and so on; roughly 15 lines).
Store `response.Cookies()` against the upstream URL; add the jar's cookies to
outgoing requests; never send `Set-Cookie` to the browser. Sessions would
reset whenever the proxy session ends. `document.cookie` throws in the
opaque-origin sandbox regardless, so this only helps sites with server-side
(HttpOnly-style) cookie sessions.

Decision: defer until an app actually needs it.

### 5. Document what a proxied page can and can't do (documentation)

From the sandbox without `allow-same-origin` (opaque `"null"` origin) and the
rewrite rules. Worth a section in the README's Browser pane notes:

- `localStorage`, `sessionStorage`, IndexedDB and `document.cookie` throw.
- `window.origin` is `"null"`, so `postMessage(msg, window.origin)` throws
  (`"null"` isn't a valid target); use `"*"` and check `event.source` on the
  receiving side. Confirmed in Chrome: `window.origin` is `"null"` and
  `location.origin` is Tessera's real address, so the original note about
  `location.origin` was wrong.
- A page can't read a child frame's `contentDocument`, even one from the same
  site.
- Cookies are not kept (item 4).
- HTML rewriting covers only `src`, `href`, `action` and `poster` attributes
  with a root-relative value. `data-*` attributes match only when the name
  ends in `href`/`src` (for example `data-href`); `srcset` and URLs assembled
  in JavaScript are not rewritten except through the patched network APIs.
- Script navigation behaves as described in item 3.

## Changes

- `internal/httpapi/browser_proxy.go`:
  - No `<base>` is injected. The bootstrap goes after `<head…>` with any
    attributes; without a head, after a byte-order mark, comments, the
    doctype and `<html…>`.
  - `Location` resolves against `response.Request.URL` and keeps its
    fragment.
  - Bootstrap: `window.open` goes through `proxyURL`; links with a non-`_self`
    target get their `href` rewritten instead of being skipped.
  - `escapedBrowserNavigation` / `writeBrowserProxyEscape`: a GET or HEAD with
    `Sec-Fetch-Dest: iframe` (or `frame`), not `Sec-Fetch-Site: same-origin`
    (Tessera's own terminal-file frame) and not under `/browser-proxy/` gets a
    403 static page: no `X-Frame-Options`, CSP `sandbox allow-scripts`,
    `default-src 'none'`, the one script allowed by hash, `frame-ancestors
    'self'`, and the HTML-escaped path.
- `internal/httpapi/security.go`: the security handler answers escaped
  navigations before the auth gate, rate limiter and app.
- `web/app.js`: `handleBrowserPaneEscape` relays the escape page's path back
  into the pane's proxy session with `location.replace`.
- README (Browser pane limits), CHANGELOG.
- Cookies (item 4): deferred, unchanged.

## Verification plan

- Go tests in `browser_proxy_test.go`:
  - HTML responses no longer get an injected `<base>`; a page's own `<base>`
    is left as the first one.
  - The bootstrap lands inside `<head lang="en">`, and in a document with no
    `<head>` it comes after the doctype, which stays first.
  - A `301 Location: ./?q=1` from `/a/b/index.html` becomes
    `{prefix}/a/b/?q=1`; a redirect to another origin is still refused.
  - A non-proxy path requested with `Sec-Fetch-Dest: iframe` gets the
    explanatory page with `frame-ancestors 'self'`; without that header the
    response is unchanged.
- Headless Chrome over CDP, all inside an iframe with the pane's sandbox
  flags, against a page in a subdirectory with:
  - relative script and image references and a redirect;
  - an `href="#x"` link, which stays on the page;
  - a `location.href = '/x'` navigation;
  - `window.open('/x')` and a `target="_blank"` link, which stay inside the
    proxy;
  - a check of `location.origin` and `window.origin` for item 5.
- DadGames end to end: select a profile, launch Snake, let it save and
  submit a score, then Esc back to the guide.
- Safari (macOS and iPad): repeat the DadGames run; check the Navigation API
  intercept (where supported) and the fallback page.

## Verification

- Go (`browser_proxy_test.go`): no `<base>` injected; bootstrap placement for
  a plain head, `<head lang="en">`, a BOM/comment/doctype document with no
  head (a `<header>` element doesn't match), and a fragment; `./?q=1` from
  `/a/b/index.html` becomes `{prefix}/a/b/?q=1`, `next#part` keeps the
  fragment, and a redirect to another origin is still a 502; the escape page
  for a cross-site iframe navigation (escaped path, policy, no
  `X-Frame-Options`), but not for a same-origin frame, a proxy path, or an
  unframed request (which keeps `DENY`). `go test ./...` passes.
- Node: `handleBrowserPaneEscape` relays only absolute paths from its own
  frame. All 694 web tests pass.
- Headless Chrome over CDP: a scratch Tessera, a loopback test site, and a
  frame with the pane's sandbox flags inside Tessera's page, with a harness
  copy of the app's relay. A page in `/games/snake/` loaded its relative
  script, image and `fetch`; `href="#x"` stayed on the page; the
  `index.html` → `./?p=1` redirect landed in `/games/snake/?p=1`;
  `location.replace("/y?z=1")` and `location.assign("/y?z=1#h")` went through
  the escape page and back into the proxy; `window.open("/x")` and a
  `target="_blank"` link opened inside the proxy; a no-head document stayed
  in standards mode.
- Found while testing: `location.href = "/x"` in an inline script already
  stays in the proxy, because the HTML attribute rewrite matches `href="/x"`
  in script text too. This is a side effect, and the escape relay covers the
  cases it misses.
- Not yet: DadGames end to end; Safari on macOS and iPad (escape page and
  relay, which depend on Safari sending `Sec-Fetch-Dest`, supported since
  16.4).
