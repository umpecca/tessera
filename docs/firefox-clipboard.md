# Firefox clipboard bridge

Tessera can embed and serve an optional Firefox extension for text clipboard
access. It targets Firefox 115 ESR with Manifest V2. No extra server process,
listening port, or external clipboard service is needed.

## User setup

Open **Settings → Clipboard**. The section reports the connection and installed
version, offers the bundled package, and links to installation instructions.

A signed XPI uses Firefox's normal installation prompt. If direct installation
is blocked, download it and use **about:addons → gear → Install Add-on From
File**. The extension is installed in the client browser profile, not on the
machine running Tessera. Enable each Tessera address through the extension's
toolbar popup, then use **Check connection**. Permissions persist across
browser restarts for a normally installed extension.

Unsigned builds explicitly offer a development ZIP. Extract it and select its
`manifest.json` under **about:debugging → This Firefox → Load Temporary Add-on**.
Temporary installation lasts only until Firefox closes.

## Build and Mozilla signing

`npm run build:clipboard` builds the reproducible development ZIP and metadata
under `web/extensions/`. `npm run build:web` runs this step too. Go embeds those
files along with the SPA, so a built executable serves them without local
extension files. Generated packages/metadata are checked in for ordinary
`go build` users, just like the vendor bundles.

To distribute a normal installation:

1. Build the development ZIP. Submit it to Mozilla using the **self-distributed
   / unlisted** option. This requires a Mozilla developer account; it does not
   require a public add-on-store listing. The stable extension ID is
   `clipboard-bridge@tessera.local`.
2. Download the signed XPI returned by Mozilla.
3. Run `npm run build:clipboard -- --signed /path/to/mozilla-signed.xpi`.
4. Run `npm run build:web`, test installation in Firefox 115 ESR, and build
   Tessera normally. Include `web/extensions/tessera-clipboard.xpi` and updated
   metadata in the release sources.

The packager requires matching source bytes and Mozilla signing entries and
rejects additional code. It does **not** verify the cryptographic signature;
Firefox does that during installation. Only use the XPI returned by Mozilla.
Existing signed packages are preserved by subsequent builds and rejected if
their sources no longer match. After changing extension sources, increment the
extension version and obtain a fresh signature; to return to development mode,
remove the old XPI explicitly before rebuilding.

No signing credentials belong in the extension or executable. Signing is a
release operation and has not been performed merely by building the repository.

The extension has no `update_url`: users update through Tessera's download
control. Numeric version comparison offers Update when the bundled version is
newer, without proposing a downgrade. A future automatic update feed would
need a stable HTTPS location independent of each user's Tessera host address.

## Access boundaries

- Clipboard permissions are requested at installation. Host permissions are
  optional and requested from the extension popup when enabling an address.
- Firefox match patterns cover all ports for a hostname; stored authorization
  and background checks restrict each request to the exact origin, including
  port. Disabling an address revokes that authorization immediately, even if
  the browser retains its broader host permission.
- Content scripts run only in the top frame. The background independently
  checks frame identity, extension sender identity, allowed origin, and Tessera
  root/session paths. Browser proxy paths and Browser-pane frames are excluded.
- A recent trusted click/key event permits one ordinary operation. Reads do
  not poll the clipboard. Terminal writes require a separate per-origin opt-in;
  this controls extension-assisted writes, not the browser's native behavior.
- The background uses an extension-owned textarea and `execCommand` under
  extension permissions, supporting Firefox 115 and HTTP without exposing its
  temporary clipboard field to page scripts. Only requested read results are
  returned to the approved page. No clipboard data is logged or persisted.
- Text is bounded to 1,048,576 UTF-16 code units per operation. Rich clipboard
  formats, images, and file transfer are not supported.
- Page messages are not authentication against other scripts already running
  in the trusted Tessera page. Only approve your trusted server. No website can
  enable its own origin through the page bridge.

Editor/terminal Copy/Paste, VNC clipboard transfer, and optional OSC 52 writes
use the bridge when connected. Existing native keyboard handling and browser/
internal clipboard fallbacks remain. Bridge timeouts are bounded, and a late
reply cannot satisfy a different request. Settings checks and window focus
refresh discovery; clipboard discovery never reads clipboard contents.

## Verification

Automated tests:

```text
node --test web/clipboard-bridge.test.mjs extensions/firefox-clipboard/bridge.test.mjs
go test ./scripts/package-clipboard ./web ./internal/httpapi
```

Manual Firefox 115 checklist: install temporarily, enable the exact address,
check connection, copy external text into editor/terminal via menu Paste,
transfer VNC text both ways, test OSC 52 with the toggle off/on, remove the
origin, reload, restart with a signed installation, and verify HTTP LAN access.
Test the physical High Sierra keyboard, clipboard, and window-focus behavior
before claiming macOS certification.

References:

- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Interact_with_the_clipboard
- https://extensionworkshop.com/documentation/publish/self-distribution/
- https://extensionworkshop.com/documentation/publish/install-self-distributed/
