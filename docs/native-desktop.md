# Tessera Desktop for macOS

Tessera Desktop is an additional application target containing the same embedded
web UI and Go backend as the webserver. Its window uses Cocoa and WKWebView directly.
There is no Wails dependency. The existing `cmd/tessera` executable, CLI flags,
Ubuntu installer, server release workflow and server artifact names are unchanged.

Status: implementation ready for macOS build/GUI validation. The development host
for this change was Windows; no macOS executable or successful native GUI run is
claimed. The new independent workflow compiles Apple Silicon and Intel previews.
macOS 12 or newer is the initial deployment target; performance and compatibility
on the minimum OS still need real-device validation.

## Build on a Mac

Install the Go version from `go.mod` and Xcode Command Line Tools. From the repo:

```sh
bash scripts/build-desktop-macos.sh
open "bin/desktop/$(go env GOARCH)/Tessera Desktop.app"
```

The script uses the committed embedded web assets. If frontend bundle inputs have
changed, first run `npm ci && npm run build:web`, just as for a server build.
Set `VERSION=v0.1.0` to embed a version, or `GOARCH=amd64` / `GOARCH=arm64` to build
the other Mac architecture with the local Apple SDK.

Output includes `Tessera Desktop.app` and `tessera-desktop-darwin-<arch>.zip` under
`bin/desktop/<arch>/`. Copy the app to Applications if desired. The preview is
ad-hoc signed, not Developer ID signed or notarized; public distribution and
automatic desktop updates are not implemented.

The **Desktop macOS preview** Actions workflow can be run manually after these
changes are pushed. It is also triggered by relevant pull requests, and uploads
the desktop ZIPs as workflow artifacts. It does not publish a GitHub Release and
is not a dependency of the server release workflow.

## Local-only behavior

- A single Go process owns the native window, SQLite database, terminal processes,
  audio manager and private HTTP listener. No external browser is launched for
  the workspace. WebKit may use its normal OS helper processes.
- The listener binds only to `127.0.0.1`. A fresh 256-bit credential is inserted
  directly into the webview's HTTP-only session cookie before loading the UI.
  It is not passed in a URL, command-line argument or persisted profile file.
- Requests must have the exact bound Host, a loopback peer and the credential.
  Foreign origins are rejected, including opaque-origin requests to workspace
  APIs. The Browser proxy alone accepts its sandbox's opaque origin and uses its
  existing 192-bit per-target URL capability instead of the app cookie, which
  sandboxed fetches and preflights cannot reliably send. Creating or deleting a
  proxy requires the app credential; its URL grants no workspace API access.
- The webview blocks requests outside its exact local origin. Desktop Browser
  panes use Tessera's existing local-port proxy and an additional restrictive CSP;
  their upstream pages receive no desktop cookie. Direct external resources in
  proxied pages are blocked, so pages requiring a CDN may need local assets.
- External links clicked in the main workspace open in the system browser.
  Browser panes cannot navigate the native window or use the native lifecycle
  bridge. That bridge only handles save/quit acknowledgement.
- Saved Local HTTPS settings are ignored. Its configuration/certificate routes
  and server update routes are denied, and the related palette items are hidden.
  There is no desktop listener configuration or remote-access flag.

This prevents inbound remote access to Tessera. It does not sandbox terminal
programs: commands can use the network or start their own listeners. Outgoing VNC
and backend audio URL requests continue to work. They use the existing shared
handlers, not unrestricted webview network access.

## Profile and lifecycle

Desktop data lives in `~/Library/Application Support/Tessera Desktop/`, separate
from the server's `Tessera` directory. Both targets share schema and migrations,
but do not open the same database by default. No automatic import is performed.

An exclusive file lock allows one desktop process per profile. A second launch
activates the first. The initial listener uses an OS-assigned port and saves it
in the profile's `port` file. Reusing it preserves the webview origin and device
preferences. If the port is occupied, startup fails instead of navigating to
another process. After checking which process owns the port, a user can remove
the `port` file while the app is closed to select a new one; this resets browser
preferences associated with the old origin, not the SQLite workspace.

The webview uses the app bundle's persistent website data store, separate from
Safari and server clients. Launch the `.app` bundle for the intended identity.
Finder launches start in the user's home directory and obtain PATH from the
user's login shell, with a five-second timeout and standard Mac paths as fallback.

Closing the window or choosing Quit asks before stopping managed work, awaits
workspace and user-setting saves, then closes terminal/audio/run managers and
SQLite. If saving fails or times out, the app offers Keep Open or Quit Without
Saving. Persisted editor buffers are retained; quitting does not write unsaved
edits to their source files. There is no background tray host after closing.

File inputs use native open panels; downloads use a native save panel and stage
the completed file before replacing an existing destination. Native Edit menu
commands and ordinary web clipboard handling are used. Optional audio capture
and encoder companions are still optional; place them beside the executable in
`Contents/MacOS` or on PATH. There is no automatic encoder download in this build.

## Validation

Verified on the Windows development host:

- Full Go suite for existing server behavior; desktop profile tests separately
  with `go test -tags desktop ./internal/nativeapp`.
- Desktop policy rejects missing/wrong credentials, non-loopback bindings, remote
  peers, foreign hosts/origins, HTTPS administration and updates.
- Persisted HTTPS configuration cannot open another desktop listener.
- Real WebSocket upgrade and incremental response flushing through desktop policy.
- Cookie-free sandbox fetch/preflight with scoped Browser proxy capabilities;
  unknown capabilities are rejected and no desktop cookie reaches the target.
- Audio SSE subscribers close cleanly during desktop shutdown.
- Stable profile port, port-conflict refusal, credential rotation on relaunch.
- All frontend tests, including save-before-close, cancellation and save failure.
- `go vet ./...` and the ordinary Windows server executable build.
- Existing Linux amd64 and arm64 server cross-builds with CGO disabled.

Required on macOS before treating the preview as validated:

1. Run `go test ./...`, `go test -tags desktop ./internal/nativeapp ./cmd/tessera-desktop`,
   and `bash scripts/build-desktop-macos.sh`. Confirm launch from Finder without
   development tools on the target machine.
2. Test initial load, relaunch, stable preferences, second-instance activation,
   window geometry, error dialogs, and close/save/force-quit behavior.
3. Exercise terminal input/resize/reconnect/Sixel, large output, IME, Command-key
   copy/paste, worksheet incremental output, and editor/file operations.
4. Exercise native upload/download panels, overwrite/cancel, audio SSE/playback/
   seeking, VNC, and Browser proxy pages/redirects/hot-reload sockets.
5. Confirm `document.cookie` cannot read the session credential. Attempt API calls
   from a sandboxed Browser pane and HTTP/WebSocket requests to another local port;
   those must fail without leaking the cookie. Inspect listeners and test a second
   computer cannot reach the desktop, while unauthenticated local curl is denied.
6. Test sleep/resume, WebKit process recovery, Retina performance and Intel/Apple
   Silicon compatibility on every OS version claimed for release.

The macOS workflow verifies compilation and packaging, not these interactive
checks. Minimum-OS verification, native performance comparison, signing,
notarization and automated desktop updates remain follow-up work.
