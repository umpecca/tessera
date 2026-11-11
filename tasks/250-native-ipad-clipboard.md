# Task 250: Native iPad clipboard

Status: implemented (2026-11-09); physical-iPad paste-permission and read-flow
validation remains pending.

## Request

Implement improvement #1 from the iPadOS app list: native text/image clipboard
access, including over HTTP/Tailscale, restricted to the selected Tessera server.
Builds on [task 196](196-native-apple-app.md).

## Implementation

- `apple/Tessera/NativeClipboard.swift`: explicit WebKit reply-handler bridge
  to `UIPasteboard`. Capability discovery reads no clipboard data. Each read
  requires native confirmation and respects iPadOS's own paste permissions.
- `apple/TesseraCore/Sources/TesseraCore/ClipboardPolicy.swift`: selected-origin, main-frame,
  app-route and foreground checks. Embedded/proxied/downloaded pages are denied,
  including a proxied page navigated into the main frame.
- Reload/navigation, server changes and web-view teardown invalidate pending
  approval. Consent expires after 90 seconds and concurrent reads are rejected.
- Text is bounded to 1 MiB UTF-8; images to 16 MiB / 16 megapixels. Reads export
  PNG; native image writes accept decoded PNG/JPEG through the web adapter.
- `web/clipboard-bridge.mjs`: discover the real top-frame native capability,
  without spoofable user-agent detection or overriding browser clipboard APIs.
  The Firefox extension and ordinary browser paths remain unchanged.
- Terminal Copy/Cmd+C, Copy Command Output, diagnostics, text clipboard actions,
  terminal Paste and Save Clipboard integrate with the native bridge. Image
  paste reuses the existing host-clipboard transport; its server requirements
  still apply. Normal system Cmd+V/edit-menu paste is unchanged.
- Cancelled/refused native reads never fall back to stale internal text.
  Native OSC 52/background terminal writes are disabled. Settings and Diagnostics
  identify the app bridge rather than suggesting a Firefox extension.
- The shared Mac target builds unchanged without enabling this iPad-only bridge.
  Both the iPad app and Tessera server must be updated.

The bridge trusts scripts already running in the selected top-level app. It
does not make plain HTTP safe on an untrusted network; HTTPS or a trusted VPN
remains necessary.

## Verification

- Full JavaScript suite: **1001 passed, 0 failed**.
- Swift package: **9 tests passed**, including origin/frame/foreground/route
  boundaries and payload limits.
- iOS Simulator and macOS app builds passed.
- Release iPad device build and unsigned `.ipa` packaging passed; verified
  iPad-only, iPadOS 18+, `com.jaxdad.tessera`, with no code signature. Requires
  signing through Xcode, SideStore or AltStore before installation.
- `scripts/apple-clipboard-smoke.mjs`: real iPad WKWebView native discovery,
  generated Unicode text/PNG writes over HTTP, iframe/proxy denial, and navigation
  while consent is pending. Uses and removes a disposable simulator; does not
  read a personal clipboard or approve system paste permission.
- Go tests/vet, web build, JavaScript syntax/diff checks and embedded-asset
  desktop/phone Chromium smoke checks passed.

## Remaining physical-device checks

- Allow/Don't Allow iPadOS paste permission; text and screenshot paste.
- Native Cancel and timeout; no stale text sent after either.
- Switching/reloading servers during approval; background/resume.
- Cmd+C/Cmd+V and editing-menu paste; terminal image paste into a supported host.

No commits or pushes. Tag-triggered CI/CD is unchanged. Other iPad improvement
items and account isolation remain outside this task.
