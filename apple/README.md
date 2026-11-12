# Tessera for iPad and Mac

A native app that shows the Tessera web client from a server you choose. It
is a thin client: the server, its web app and its flags are unchanged, and
everything Safari can do in Tessera works the same here. One SwiftUI target
builds for iPadOS 18+ and macOS 15+.

## What it does differently from Safari

- Asks for a server address on first launch (`studio`, `100.64.0.2:8080`, or
  a full `https://` URL). Without a scheme the address is HTTP; without a
  port it is 7331, Tessera's default. **Change Server…** (Shift+Cmd+,) and
  **Reload Page** (Shift+Cmd+R) are in the Mac menu bar and iPad's always-visible
  **… app menu**.
- Shows `confirm()` and `alert()` as native dialogs. A web view in an app
  otherwise answers them with Cancel, so closing a terminal from its title
  bar would do nothing.
- Saves downloads (terminal file transfers) to `~/Downloads` on the Mac and
  to Files › On My iPad › Tessera on the iPad.
- Opens links that leave the server, such as a browser pane's page, in the
  system browser.
- Plays terminal audio without a first tap, and reloads the page by itself
  if WebKit ends its process (deferred until foreground on iPad).
- Allows plain HTTP to any server, so Tessera over Tailscale needs no
  certificate. The iPad app has a native clipboard bridge for text and images,
  including over HTTP; the Mac app continues using the web clipboard paths.

## iPad app controls

- The touch **… app menu** opens saved servers, reload, palette/window/session
  lists, workspace settings, terminal keys, downloads, imports, diagnostics and help.
- **Distraction-Free Full Screen is on by default.** While Tessera's workspace
  fills the iPad's display and is active, the native app hides the clock/date/
  battery status bar and requests auto-hiding of the Home indicator. It uses the
  scene's actual display bounds, not the keyboard-reduced content viewport.
  Split View/Stage Manager windows, inactive scenes, native forms and sheets keep
  normal system presentation. It does not force a window to maximise or disable
  multitasking, app switching or system gestures. iPadOS may temporarily reveal
  overlays or retain controls it owns; this is immersive presentation, not kiosk mode.
- **… app menu → Distraction-Free Full Screen** (also **App Diagnostics → Display**)
  lets you opt out. The preference is saved on the device across launches and
  server changes; explicit choices from the earlier Hide Status Bar setting are
  retained. Tessera's own menu/key controls remain available. Presentation changes
  hold terminal sizing and do not intentionally focus input or reload the workspace.
  The option does not change Safari/Home Screen web apps.
- Hardware shortcuts: **Cmd+K** palette, **Cmd+L** windows, **Cmd+;** sessions,
  **Cmd+,** settings, **Shift+Cmd+,** saved servers, **Shift+Cmd+R** reload,
  **Shift+Cmd+K** terminal key row. Hold Command for system shortcut hints.
  System shortcuts and ordinary WebKit text/IME/Cmd+V remain unchanged.
- The optional touch key row supplies Escape, Tab, arrows, navigation, F1–F12,
  one-shot Ctrl/Alt and common control chords. App keys do not type through web
  dialogs; an active terminal is required.
- Named server profiles use separate persistent WebKit cookie/storage stores,
  including when two profiles use the same hostname. The migrated original
  profile retains the old default store and sign-in. Renaming preserves the
  store; changing an origin creates a new one. Removing a profile does not stop
  shells or delete downloaded files; it does not erase retained WebKit data.
- Healthy foreground/network changes reconnect the existing page, not reload it.
  Backgrounding snapshots terminal scroll/selection and holds shell sizing;
  selection restoration is skipped when the host's history changed. Native key-row
  changes also hold sizing until actual terminal interaction. State restoration is
  best-effort, not a guarantee against OS termination or host history trimming.
- Narrow iPad windows retain tablet layout unless the workspace explicitly chose
  Phone view. Rotation and resizing do not intentionally focus a text field.
- On foreground entry or device unlock, the updated app restores keyboard focus
  to the current visible foreground pane, so a hardware keyboard can continue
  without another click. Update both app and server for this integration. Native
  sheets, privacy covers, web dialogs/menus and unrelated text fields take priority;
  ordinary network reconnects and resizing do not request focus. The app uses
  public WebKit/UIKit responder APIs, never a synthetic click or keystroke.
  Phone Scroll/Select/compose modes remain unchanged. Software-keyboard display
  is controlled by iPadOS and is not guaranteed by restoring DOM focus.
- Downloads show progress/cancel, then Preview, Share and Save to Files. Files,
  Photos and drops open a web **Import Files to Host** review, never an automatic
  shell command. Imports allow eight files, 16 MiB each and 32 MiB per batch;
  Photos export PNG up to 16 megapixels. Update the server for these integrations.
  Switching profiles cancels in-progress native downloads. Completed downloads
  remain in the app's shared device Documents folder, not in a profile's sign-in store.
- Native forms support Dynamic Type and labeled VoiceOver controls. Workspace
  typography remains independent. Icons reuse the existing Tessera artwork;
  regenerate them with `swift apple/generate-icons.swift`.

### Rendering and connection diagnostics

**App Diagnostics** offers a high-refresh preference and bounded WebKit rAF
measurement. The public ProMotion plist opt-in permits but cannot force higher
refresh. Low Power Mode, display capabilities, OS/WebKit policy and the workspace
Older Mac profile still limit rendering. Callback FPS is **not** physical frame
presentation or input latency. Compare app and Safari using the same server,
grid, font, workload and network; physical ProMotion/latency results are pending.

Connection errors explain DNS/Tailscale, LAN permission and certificate failures.
Use Settings → Apps → Tessera to allow Local Network where needed. Local HTTPS
requires the correct hostname and a trusted CA (install the profile and explicitly
enable trust in Settings → General → About → Certificate Trust Settings).
The app never disables TLS validation; only trust a CA you control.

## Native iPad privacy

**… app menu → Privacy…** provides two device-local preferences:

- **Hide app-switcher preview** defaults to on. As the scene becomes inactive,
  opaque native covers obscure each app window (including presented sheets),
  with a separate generic Tessera window above them. Server addresses, terminal
  contents and download names are not drawn in that preview. **Preview Privacy
  Shield** lets you check the appearance without leaving the app.
- **Require device unlock** is opt-in. Enabling **or disabling** it first requires
  successful system device-owner authentication: Face ID, Touch ID or the iPad's
  passcode. A passcode must be configured. It locks on cold launch and genuine
  backgrounding, not merely when a permission/authentication sheet makes the scene
  inactive. Cancellation/failure keeps it locked, with an explicit retry button;
  returning from the authentication sheet does not create a prompt loop.

A locked app blocks native app commands/clipboard access, ends terminal editing
and owns input in its lock window. Cold launch does not construct a saved-server
web view until the first successful unlock. Background locking retains an existing
workspace beneath the cover and resumes it after authentication; host terminals
are not stopped. Late authentication replies after backgrounding are discarded.
Other scenes re-read the saved lock preference when they become active.

This is a local privacy/access feature, **not server authentication, encryption
or screenshot prevention while unlocked**. It does not clear the shared clipboard,
erase server data or conceal iPadOS/system-owned notifications, pickers or other
apps. Use an iPad passcode, trusted server and appropriate server sign-in. Physical
checks remain for real app-switcher snapshots, Face ID/Touch ID/passcode fallback,
device lock/unlock, permission dialogs and Stage Manager/multiple windows.
Deterministic authentication responses used by simulator UI tests are compiled
only for DEBUG simulator builds with isolated test-launch arguments; Release
builds always use LocalAuthentication.

## Native iPad clipboard

With an updated app **and Tessera server**, terminal Copy (including Cmd+C),
Copy Command Output, diagnostic copying, and Tessera's text clipboard actions
use the iPad pasteboard. Terminal **Paste** accepts text or an image; **Save
Clipboard to File** can read either. Image paste still needs a supported host
clipboard on the server to deliver the image to a terminal program. Normal
Cmd+V and the iPadOS editing menu keep their existing system paste behavior.

Each app-mediated read asks **Paste into Tessera?**, identifying the server,
before accessing the pasteboard. iPadOS may also request its own paste permission.
Cancelling, declining, or timing out never pastes Tessera's last copied text.
Capability checks and opening Settings do not read clipboard contents.

Access is restricted in native code to the foreground app's selected server,
its top-level Tessera app routes, and the actual requesting frame's origin.
Embedded browser panes, proxied/downloaded pages and other origins cannot use
the bridge. Reloads/navigation, server changes and web-view teardown invalidate
pending approval. This does not protect against scripts already running inside
the trusted top-level Tessera app. Plain HTTP on an untrusted network is still
unsafe; use HTTPS or a trusted VPN.

Text is limited to 1 MiB UTF-8. Images are limited to 16 MiB and 16 megapixels;
native reads export PNG, and the bridge supports writing PNG/JPEG images.
Terminal-initiated (OSC 52) **native** clipboard writes are disabled; ordinary
browser/internal-buffer behavior is unchanged. Settings → Clipboard and
Diagnostics identify the native bridge rather than suggesting an extension.

Physical-iPad checks remain: Allow/Don't Allow paste permission, text and
screenshot round trips, cancellation, server switching during approval, and
background/resume. Browser protocol tests and a simulator build are not a
substitute for those device checks.

Settings → Diagnostics in Tessera reports the browser as `Tessera app`.
Safari's Develop menu can inspect the page, as with Safari itself.

## Build and run

Open `Tessera.xcodeproj` in Xcode 27 or later.

- **Mac:** choose the *My Mac* destination and Run. Without an Apple ID
  in Xcode, set Signing to *Sign to Run Locally*.
- **iPad simulator:** choose an iPad simulator and Run. A server on the Mac
  is reachable from the simulator at `127.0.0.1`.
- **Your iPad:** add your Apple ID under Xcode → Settings → Accounts, then
  pick its Personal Team under the target's Signing & Capabilities. Connect
  the iPad, turn on Developer Mode on it when asked (Settings → Privacy &
  Security), and Run. With a free Apple ID the app stops opening after 7
  days; run it from Xcode again to renew it.

From the command line (with Xcode selected by `xcode-select`, or
`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`):

```sh
xcodebuild -project apple/Tessera.xcodeproj -scheme Tessera \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
xcodebuild -project apple/Tessera.xcodeproj -scheme Tessera \
  -destination 'platform=macOS' build CODE_SIGN_IDENTITY=-
swift test --package-path apple/TesseraCore
node scripts/apple-ipad-tests.mjs --output=/path/to/temporary/directory
```

For a native clipboard smoke check, build the simulator app with an explicit
`-derivedDataPath`, then run:

```sh
node scripts/apple-clipboard-smoke.mjs --app=/path/to/Build/Products/Debug-iphonesimulator/Tessera.app
```

It creates and removes a disposable iPad simulator, writes only generated test
clipboard data, checks real WebKit/native calls over HTTP, rejects iframe and
proxied-page access, and navigates away while paste consent is pending. It does
not read a personal clipboard or approve the iPadOS paste permission dialog.

`apple-ipad-tests.mjs` creates/removes a disposable iPad and runs the shared
`Tessera-iPad` UI-test scheme: generated loopback fixtures test profile storage,
touch commands, key row, status-bar hiding/restoration and persistence, rotation, download actions, frame measurement and native
accessibility descriptions at XXXL text. This is not physical-device certification.
Check real keyboard reserved keys/Command hints, floating keyboard, trackpad,
Split View/Stage Manager, paste permissions and 120 Hz/latency on an actual iPad.

### Installing without Xcode

Xcode can't reach an iPad over Tailscale, only over a cable or the same
Wi‑Fi. To install from the iPad instead, build an unsigned app file and let
[SideStore](https://github.com/SideStore/SideStore) or AltStore sign it with
your Apple ID:

```sh
bash apple/build-ipa.sh            # writes apple/build/Tessera.ipa
bash apple/build-ipa.sh --output ~/Desktop/Tessera.ipa
```

Copy the `.ipa` to the iPad (a Tessera terminal file transfer into Files
works) and open it in SideStore or AltStore. Both need a cable once to set
up, then sign on the iPad with their own local VPN, so Tailscale disconnects
while they install or renew the 7-day signature. A free Apple ID allows three
sideloaded apps, and the sideloading app is one of them.

For updates, sign/install the new IPA with the same bundle identifier and signing
identity without deleting Tessera. Deletion may remove profiles, downloads and
sign-ins. Keep the server current too. The app does not silently install updates
or certificate profiles.

The server's DNS-rebinding check applies to the app as to any browser: add a
Tailscale MagicDNS or proxy name you connect with to `-allowed-host`.

## Layout

- `Tessera/`: the app. `TesseraWebView.swift` configures the web view and
  handles navigation, dialogs and downloads; `Platform.swift` holds the
  UIKit and AppKit versions of each; `ContentView.swift` is the address
  form and connection error screen on Mac. `IPadRootView.swift`,
  `IPadAppModel.swift` and `IPadWebView.swift` provide iPad controls, profile and
  recovery state, and public responder-chain keyboard commands. Files added here are part of the
  target automatically.
- `TesseraCore/`: a Swift package of platform-independent logic (address
  parsing, download names, profiles, shortcuts and recovery), tested with `swift test`.
- `Tessera-Info.plist`: App Transport Security and Files app settings; the
  rest of the Info.plist comes from build settings.
- `build-ipa.sh`: the unsigned `.ipa` for SideStore or AltStore.
