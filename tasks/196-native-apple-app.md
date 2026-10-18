# Task 196: Native iPad and Mac app, first milestone

Status: complete (on-device and interactive checks pending)

## Request

Start the native app, ideally one codebase for iPadOS and macOS. Decisions
(2026-10-17): code in `apple/` in this repo, app "Tessera" with bundle ID
`com.jaxdad.tessera`, signed with a free Apple ID (iPad installs last 7
days).

This differs from the macOS desktop app retired in task 184, which embedded
the server: this one is a thin client of a server the user runs elsewhere,
usually reached over Tailscale.

First milestone: a WKWebView app that runs on the iPad and the Mac, to then
answer what only an app can (task 188: 120 fps rendering; which reserved
keyboard shortcuts an app can claim; latency against Safari) before choosing
native features.

## Changes

- `apple/Tessera.xcodeproj`: one multiplatform SwiftUI target (iPadOS 18,
  macOS 15; iPad only on iOS, no Catalyst) using a folder-synchronized group,
  so files added to `apple/Tessera/` need no project edit. Swift 6 with
  MainActor default isolation. Mac sandbox with outgoing network, Downloads
  read-write and user-selected read-only files; hardened runtime.
- `apple/Tessera-Info.plist`: `NSAllowsArbitraryLoadsInWebContent` and
  `NSAllowsLocalNetworking` for plain HTTP to any server; Documents shared in
  the Files app. The rest of the Info.plist is generated from build settings,
  including the local network usage description.
- `apple/Tessera/TesseraWebView.swift`: persistent website data (sign-in
  cookie, settings), media without a user gesture (terminal audio), user
  agent suffix `TesseraApp/<version>`, inspectable, no bounce or back
  gestures. Delegates supply what Safari would:
  - `confirm`/`alert`/`prompt` as native alerts. Without them WKWebView
    answers `confirm` with false at once, and Tessera confirms before
    closing a terminal from its title bar and before deleting shortcuts.
  - Downloads: attachment responses and `download` links become
    `WKDownload`s saved by `TesseraCore.DownloadDestination`, numbered
    rather than replacing a file. Terminal file transfers submit a form into
    a hidden frame that returns an attachment.
  - Main-frame navigation off the server's origin, `window.open` and
    target=_blank go to the system browser; frames inside the page load
    freely. The Local HTTPS enrollment tab gets null from `window.open`,
    which the page already handles.
  - A failed first load or reload shows a native error screen; after a
    load, Tessera reconnects by itself. A terminated web content process
    reloads.
- `apple/Tessera/Platform.swift`: UIKit and AppKit versions of opening
  URLs, alerts (sheets on the Mac), the Mac open panel, the downloads
  folder, and the finished-download notice (iPad alert; Mac Downloads stack
  bounce).
- `apple/Tessera/ContentView.swift`, `TesseraApp.swift`: address form on
  first launch and from **Change Server…** (Shift+Cmd+,); **Reload Page**
  (Shift+Cmd+R). Neither collides with Tessera's shortcuts.
- `apple/TesseraCore`: `ServerAddress.parse` (no scheme means HTTP and, with
  no port, 7331; `studio:8080` is not read as a scheme) and `sameOrigin`;
  `DownloadDestination`.
- `web/compatibility.mjs`: `browserName` reports `Tessera app <version>`.
- `.gitignore`: Xcode and SwiftPM state. `README.md`, `ARCHITECTURE.md`,
  `CHANGELOG.md`, `apple/README.md`.

## Validation

- `swift test` in `apple/TesseraCore`: 6 tests (address forms, rejections,
  origins, download numbering, names kept inside the folder).
- `xcodebuild` for the iOS Simulator and for macOS: both succeed with no
  warnings.
- iPad Pro 11-inch (M5) simulator, iOS 27.1, against a local server: the
  first-run form; the Tessera page loaded over HTTP (its own Local HTTPS
  notice showed, correctly, since the page is still not a secure context);
  the error screen for a closed port.
- Mac app with the address as a launch argument: its WebKit network process
  held six connections to the server. A window screenshot was not possible
  from this session (no screen recording permission).
- `web/compatibility.test.mjs` covers the app's user agent on both
  platforms. Full JavaScript suite passes.
- Not yet checked by hand: dialogs, downloads, the Mac file picker, audio,
  and running on the iPad itself.

## Next

1. Run it on the iPad. Compare Settings → Diagnostics echo times and the
   task 194 key readout with Safari's.
2. 120 fps: whether the app's web view renders above 60 fps on ProMotion.
3. Keyboard: which reserved shortcuts the app can claim
   (`UIKeyCommand.wantsPriorityOverSystemBehavior`); whether the Mac menus'
   key equivalents (such as Edit › Spelling's Cmd+;) take Tessera's
   shortcuts; hiding the shortcut bar the iPad shows over the terminal's
   hidden text field.
4. Then native features: clipboard bridge, trusting the Local HTTPS
   certificate in the app, an app icon.
