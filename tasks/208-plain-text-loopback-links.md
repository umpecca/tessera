# Task 208: Open printed loopback addresses in a Browser window

Status: complete (iPad check pending)

## Request

Task 207 sent OSC 8 links to `localhost` and `127.0.0.1` to a Browser
window. Do the same for addresses detected in plain text, which is how most
dev servers print theirs (`http://localhost:5173/`).

## Findings

- Two providers detect addresses in text. ghostty-web's `UrlRegexProvider`
  works one row at a time and calls `window.open` itself. Tessera's
  `WrappedHTTPLinkProvider` joins soft-wrapped rows and took an `openURL`
  argument that `app.js` never passed. For the same range on one row,
  ghostty-web's link cache keeps the later provider's link, which is
  Tessera's.
- Wrapped addresses had never been joined on screen. The core's
  `isRowWrapped` returns `wrap_continuation` (the row continues the one
  above, xterm.js's meaning), but `WrappedHTTPLinkProvider` and its test read
  `isWrapped` as "continues onto the next row". So the provider found nothing
  on a wrapped address, and ghostty-web's provider, seeing only the first
  row, opened a truncated address from that row. The rest was not a link.

## Changes

- `web/terminal-links.mjs`:
  - `RoutedLinkProvider` wraps ghostty-web's provider and hands its `http`
    and `https` links to `openURL`, with the same Ctrl/Cmd rule. Other
    schemes it detects (`mailto:`, `ssh:`) keep ghostty-web's handling.
  - `replaceHyperlinkProvider` became `replaceLinkProvider(detector,
    isBuiltIn, replace)`, where `replace` gets the built-in provider, so a
    replacement can wrap it.
  - `WrappedHTTPLinkProvider` reads `isWrapped` as the core reports it.
- `web/terminal-entry.js`: ghostty-web's address provider is wrapped in
  place, opening through the terminal's `openLink`.
- `web/app.js`: `WrappedHTTPLinkProvider` gets `openTerminalLink`.
- `web/vendor/terminal.js` rebuilt. `README.md`, `CHANGELOG.md`.

Scrollback rows always report `isWrapped` false (ghostty-web reads it only
for the active screen), so an address wrapped in scrollback is still not
joined.

## Validation

- `web/terminal-links.test.mjs`: ghostty-web's http(s) links open through
  `openURL` and only with Ctrl/Cmd; a `mailto:` link keeps its own handling;
  dispose passes through; an empty row stays empty. `replaceLinkProvider`
  hands over the built-in provider. The wrapped-address test now uses the
  core's meaning, with unrelated rows on both sides: each of three rows opens
  the full address, and the next row is its own link. Full JavaScript suite:
  683 pass. `go test ./...` fails only on the unembedded `screensaver.mjs`,
  as before.
- ghostty-web's real `LinkDetector` with both providers registered in
  Tessera's order, over a 105-character loopback address wrapped across two
  68-column rows: Cmd-click on either row opens the full address.
- Real host, headless Chrome over the DevTools protocol, `python3 -m
  http.server` on `127.0.0.1:8765`, fresh workspace:
  - a shell printing `http://127.0.0.1:8765/ https://example.com/`: Cmd-click
    on the first opened Browser 1 showing the served page; Cmd-click on the
    second opened a tab and no window;
  - a shell printing a 105-character `127.0.0.1:8765` address wrapped onto a
    second row: Cmd-click on the second row opened a Browser window at the
    full address. Before the wrap fix, neither row of the wrapped address was
    underlined and the click did nothing.
- Not yet tried on the iPad.
