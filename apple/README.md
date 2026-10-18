# Tessera for iPad and Mac

A native app that shows the Tessera web client from a server you choose. It
is a thin client: the server, its web app and its flags are unchanged, and
everything Safari can do in Tessera works the same here. One SwiftUI target
builds for iPadOS 18+ and macOS 15+.

## What it does differently from Safari

- Asks for a server address on first launch (`studio`, `100.64.0.2:8080`, or
  a full `https://` URL). Without a scheme the address is HTTP; without a
  port it is 7331, Tessera's default. **Change Server…** (Shift+Cmd+,) and
  **Reload Page** (Shift+Cmd+R) are in the menu bar.
- Shows `confirm()` and `alert()` as native dialogs. A web view in an app
  otherwise answers them with Cancel, so closing a terminal from its title
  bar would do nothing.
- Saves downloads (terminal file transfers) to `~/Downloads` on the Mac and
  to Files › On My iPad › Tessera on the iPad.
- Opens links that leave the server, such as a browser pane's page, in the
  system browser.
- Plays terminal audio without a first tap, and reloads the page by itself
  if WebKit ends its process.
- Allows plain HTTP to any server, so Tessera over Tailscale needs no
  certificate. Over HTTP the page still has Safari's clipboard limits; a
  native clipboard bridge is planned.

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
```

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

The server's DNS-rebinding check applies to the app as to any browser: add a
Tailscale MagicDNS or proxy name you connect with to `-allowed-host`.

## Layout

- `Tessera/`: the app. `TesseraWebView.swift` configures the web view and
  handles navigation, dialogs and downloads; `Platform.swift` holds the
  UIKit and AppKit versions of each; `ContentView.swift` is the address
  form and the connection error screen. Files added here are part of the
  target automatically.
- `TesseraCore/`: a Swift package of platform-independent logic (address
  parsing, download names), tested with `swift test`.
- `Tessera-Info.plist`: App Transport Security and Files app settings; the
  rest of the Info.plist comes from build settings.
- `build-ipa.sh`: the unsigned `.ipa` for SideStore or AltStore.
