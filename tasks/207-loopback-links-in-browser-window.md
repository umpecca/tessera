# Task 207: Open loopback OSC 8 links in a Browser window

Status: complete (iPad check pending)

## Request

An OSC 8 link to `localhost` or `127.0.0.1` should open in a Tessera
Browser window instead of a new browser tab.

## Why

A loopback address printed in a terminal names the Tessera host. In a new
tab on the iPad it names the iPad, where nothing is listening. A Browser
window reaches the host's loopback ports through the browser proxy.

## Changes

- `web/app.js`: `openTerminalLink(url)` opens an address that
  `normalizeBrowserAddress` accepts (http or https, a loopback host —
  `localhost`, `127.x.x.x`, `::1` — no credentials) in a Browser window at the
  next spawn point, or brings forward a Browser window already showing it.
  Anything else opens in a new tab as before. Passed to the terminal as
  `openLink`.
- `web/terminal-entry.js`: the `openLink` option (default: a new tab) is what
  `HyperlinkProvider` calls to open a link. The http/https check and the
  Ctrl/Cmd requirement stay in the provider.
- `web/vendor/terminal.js` rebuilt. `README.md`, `CHANGELOG.md`.

Addresses detected in plain text (not OSC 8) still opened in a tab here:
their providers are separate (ghostty-web's and `WrappedHTTPLinkProvider`).
Task 208 routes them too.

## Validation

- `web/browser-pane.test.mjs`, running `openTerminalLink` from `app.js`:
  `localhost` and `127.0.0.1` links each open a Browser window at the given
  address; a link already shown raises that window; `https://example.com`, a
  LAN address and a loopback address with credentials open in a tab. Full
  JavaScript suite passes. `go test ./...` fails only on the unembedded
  `screensaver.mjs`, as before.
- Real host, headless Chrome over the DevTools protocol, `python3 -m
  http.server` on `127.0.0.1:8765` and a shell printing OSC 8 links to it and
  to `https://example.com/`: Cmd-click on the first opened Browser 1 at
  `http://127.0.0.1:8765/` showing the served page; Cmd-click on the second
  opened a tab and no window.
- Not yet tried on the iPad.
