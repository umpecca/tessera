# Browser pane

A Browser pane shows the development server in a sandboxed frame without
`allow-same-origin`, so the page has an opaque origin (`window.origin` is
`"null"`; `location.origin` still reports Tessera's address). For the page:

- `localStorage`, `sessionStorage`, IndexedDB and `document.cookie` throw.
- `postMessage(message, window.origin)` throws because `"null"` isn't a valid
  target; use `"*"` and check `event.source` when receiving.
- It can't read a child frame's `contentDocument`, even one from the same site.
- Cookies are not kept: Tessera strips `Cookie` and `Set-Cookie` in both
  directions. Carry state in the URL or a request header instead.
- HTML rewriting covers only `src`, `href`, `action` and `poster` values that
  start with `/`. `data-*` attributes match only when the name ends in `href`
  or `src` (for example `data-href`); `srcset` and URLs assembled in
  JavaScript are not rewritten, except through the patched `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource` and `window.open`.
- Link clicks and form submits stay inside the proxy. A root-relative
  navigation from script, such as `location.replace("/")`, briefly loads a
  Tessera page that sends the frame back through the proxy. If that page
  stays up, it names the path the site tried to open.
