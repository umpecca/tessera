# Browser pane

A Browser pane shows the development server in a sandboxed frame without
`allow-same-origin`, so the page has an opaque origin (`window.origin` is
`"null"`; `location.origin` still reports Tessera's address). For the page:

- `localStorage`, `sessionStorage` and `document.cookie` work, kept by
  Tessera rather than the browser (see [Site data](#site-data)). IndexedDB,
  Cache Storage and service workers are not available.
- `postMessage(message, window.origin)` throws because `"null"` isn't a valid
  target; use `"*"` and check `event.source` when receiving.
- It can't read a child frame's `contentDocument`, even one from the same site.
- The Gamepad API is allowed. A frame inside the page needs
  `allow="gamepad *"` rather than `allow="gamepad"`: the page's origin is
  opaque, so a delegation to the frame's own origin may not match.
- HTML rewriting covers only `src`, `href`, `action` and `poster` values that
  start with `/`. `data-*` attributes match only when the name ends in `href`
  or `src` (for example `data-href`); `srcset` and URLs assembled in
  JavaScript are not rewritten, except through the patched `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource` and `window.open`.
- Link clicks and form submits stay inside the proxy. A root-relative
  navigation from script, such as `location.replace("/")`, briefly loads a
  Tessera page that sends the frame back through the proxy. If that page
  stays up, it names the path the site tried to open.

## Site data

The browser keeps nothing for an opaque origin, so Tessera keeps a Browser
pane page's site data itself:

- **localStorage** belongs to your account and the development server's
  origin (`http://localhost:8080`), saved on the Tessera host. Every device
  signed in to the account sees the same items, unlike in a browser.
- **sessionStorage** belongs to the Browser pane and origin, in the host's
  memory. It survives reloads and navigation in the pane, and is dropped
  after a day unused or when Tessera restarts.
- **Cookies** go in a jar per account and origin on the host. The proxy sends
  them with every request (pages, `fetch`, XHR, `EventSource`, WebSockets)
  and keeps `Set-Cookie` away from the browser, so `HttpOnly` cookies never
  reach page script. Cookies with `Expires` or `Max-Age` are saved; others
  last until Tessera restarts. `SameSite` is kept but not enforced.
- Each of localStorage and sessionStorage holds up to 5 MiB per origin;
  going over throws `QuotaExceededError`.

A script Tessera adds before the page's own loads its data with one blocking
request and replaces `window.localStorage`, `window.sessionStorage` and
`document.cookie` with stand-ins that behave like the browser's. Changes are
sent back at the end of each task (and when the page is hidden). Limits:

- A write made just before navigating away can, rarely, be applied after the
  next page has already loaded its data.
- `storage` events aren't delivered between pages.
- Code that checks for storage support sees the stand-ins.

The pane's **⌫** button (Clear site data) clears the development server's
localStorage and cookies, and the pane's sessionStorage, then reloads the
page.
