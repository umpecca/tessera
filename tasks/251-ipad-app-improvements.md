# Task 251: Finish the iPadOS app improvement list

Status: implementation and automated verification complete; physical-device acceptance pending (2026-11-09).

## Scope

Finish items 2–10 following [native clipboard task 250](250-native-ipad-clipboard.md).
Keep the shared Mac build working, preserve existing user work and tag-triggered
CI/CD, and distinguish automated verification from physical-device results.

## Implementation checklist (physical-device acceptance is separate)

- [x] Hardware-keyboard shortcuts, discoverability and terminal key controls.
- [x] Always-reachable touch app menu, server controls and reload.
- [x] Foreground/network recovery, background sizing/focus protection and state restoration.
- [x] iPad rotation/narrow multitasking layout; retain system keyboard/trackpad/selection handling.
- [x] Download progress/cancel/preview/share/export and Files/Photos/drop imports.
- [x] Named server profiles with isolated website data and legacy migration.
- [x] Public high-refresh opt-in, measurable frame-rate diagnostics and Safari comparison guidance.
- [x] HTTP/HTTPS/certificate/local-network permission guidance without trust bypasses.
- [x] App icon, native accessibility/Dynamic Type and installation/update instructions.

## Verification required

Swift model/policy tests, web integration tests, iPad simulator and Mac builds,
repeatable simulator smoke checks, the complete JS/Go suites and unsigned iPad
packaging. Physical paste permissions, real hardware-keyboard routing and
ProMotion/latency measurements must be recorded honestly; do not label simulator
results as physical-device verification.

## Implemented boundaries

- Public UIKit key commands augment inherited WebKit commands, never private
  WebKit view internals. Reserved system keys, Cmd+V and IME stay system-owned.
- Profiles own persistent WebKit stores. Same-origin edits retain the UUID;
  origin changes create a new store. Legacy migration retains the old sign-in.
  Removing a saved entry does not erase retained website data or host shells.
- Healthy wake/network changes reconnect without replacing the document; a dead
  background process reloads once on activation. Transient inactive permission
  sheets hold sizing but do not revoke paste consent; actual backgrounding does.
- Native terminal sizing holds release on genuine terminal interaction, not app
  menu/layout changes. Scroll/selection recovery is best-effort and validates
  selection against the host history epoch and length.
- Imports open a review/save dialog, never execute commands: eight files,
  16 MiB/file, 32 MiB/batch; Photos become PNG up to 16 megapixels. Concurrent
  batches append to review, but cannot change a save already in progress.
- ProMotion opt-in and an optional 60 FPS paint cap use public mechanisms.
  Low Power Mode and Older Mac limits remain respected. rAF samples are bounded
  and explicitly do not claim presentation FPS or input latency.

## Verification evidence (2026-11-09)

- Complete JS suite: **1,013 passed, 0 failed** (`tessera-ipad-all-tests.tap`).
- Swift package: **16 tests in four suites passed**.
- Native iPad UI suite: **3/3 passed, 0 failed**, including independent profile
  cookies/localStorage, touch palette/key row/control chords, rotation, healthy
  home/foreground without reload, downloads and QuickLook preview/explicit close,
  rAF measurement and help, plus accessibility-description audit at XXXL text.
  Result: `tessera-ipad-ui-hd8CUL/Results.xcresult`; log: `tessera-ipad-ui-run.log`.
- `go test ./...`, `go vet ./...` and `npm run build:web`: passed.
- Real browser smoke: desktop/phone regressions plus native iPad narrow layout,
  controller actions, suspend/resize/resume without shell resize or focus theft,
  bounded frame sampling and import review: passed (`tessera-ipad-browser.log`).
- Real WKWebView simulator smoke: HTTP native capabilities, Unicode text/PNG
  writes, iframe/proxied-document denial, navigation during pending consent:
  passed (`tessera-ipad-clipboard-smoke.log`).
- macOS unsigned build and iPad unsigned Release packaging: passed. IPA metadata
  confirms version **0.2 (2)**, iPad-only device family, compiled AppIcon assets
  and the public high-refresh opt-in.
- `git diff --check` and syntax checks for both simulator/browser runners passed.

Unsigned install artifact: `…/T/opencode/tessera-ipad-0.2.ipa` (sign with Xcode,
SideStore or AltStore before installing; see `apple/README.md`).

Logs/artifacts are under the session-approved temporary directory (`…/T/opencode`).
Reproduce native UI verification with `node scripts/apple-ipad-tests.mjs`; this
creates/removes its own iPad and serves only generated loopback test fixtures.

## Physical-device acceptance still required

- [ ] Allow/Don't Allow system paste permission; text/screenshot round trips,
  cancellation and switching/backgrounding while approval is pending (task 250).
- [ ] Real keyboard shortcut priority/Command hints, system reserved combinations,
  Escape/modifiers/F-keys, IME and normal Cmd+V.
- [ ] Floating/split keyboard, trackpad selection/secondary click, Split View and
  Stage Manager on supported iPads; lock/unlock and real network transitions.
- [ ] Physical Files/Photos/cloud providers, external drag/drop, share/export,
  slow/cancelled downloads and VoiceOver navigation at large text sizes.
- [ ] Physical app-versus-Safari ProMotion and input-to-screen latency measurement
  under equivalent workloads. No 120 Hz/latency improvement is claimed.

## Native status-bar follow-up (2026-11-10)

- Added **Hide Status Bar** in the native app menu and **App Diagnostics → Display**,
  using SwiftUI's public status-bar preference. Defaults to visible; the device-local
  preference persists across launches. The menu remains reachable while hidden.
- Changes hold terminal sizing rather than reloading the page or focusing input.
  Safari/Home Screen behavior is unchanged; system dialogs/windowed iPadOS UI can
  still show their own controls.
- Targeted native iPad simulator test: **1/1 passed**, covering actual SpringBoard
  status-bar visibility, hide/show, rotation, unchanged workspace and both persisted
  states across relaunch. Results: `tessera-ipad-ui-OkTVIS/Results.xcresult`;
  log: `tessera-ipad-status-bar-ui-retry.log`.
- Swift package: **16 tests passed**. Mac build and unsigned iPad Release packaging
  passed. IPA metadata verified **0.2 (3)** and iPad-only device family.
- New artifact: `…/T/opencode/tessera-ipad-0.2-status-bar.ipa`. Sign/install over
  the existing app without deleting profiles/downloads/sign-ins.
- [ ] Physical iPad acceptance: status-bar hiding/restoration in full-screen,
  Split View/Stage Manager, system-sheet return and hardware-keyboard use.

## Default full-screen immersion follow-up (2026-11-10)

- Supersedes the status-bar-only control with **Distraction-Free Full Screen**,
  enabled by default while preserving explicit saved/legacy choices.
- Hides the status bar and requests Home-indicator auto-hiding only for an active
  full-screen workspace. A public UIKit scene-geometry observer distinguishes
  full-display scenes from smaller Split View/Stage Manager windows; it does not
  infer fullscreen from the keyboard-reduced content size or force maximisation.
- First-run/native sheets, inactive scenes and windowed use keep normal system
  presentation. System gestures, multitasking and Tessera's own controls remain
  available. This is not kiosk mode; iPadOS can reveal system overlays.
- Swift package: **19 tests passed**, including preference defaults/migration,
  rotation-aware fullscreen geometry and active/windowed/native-sheet policy.
- Native full-screen/rotation/preference/foreground regression now passes in the
  **6/6** native UI run `tessera-ipad-ui-S1yRf9/Results.xcresult` together with
  the privacy follow-up in task 252. Home-indicator auto-hide is an OS request;
  physical behavior and windowed transitions still need device acceptance.
- Mac build and unsigned iPad Release packaging passed; artifact metadata confirms
  **0.2 (4)**, iPad-only device family and no `UIRequiresFullScreen` restriction.
  Artifact: `…/T/opencode/tessera-ipad-0.2-distraction-free.ipa`.
- [ ] Physical iPad acceptance: Home-indicator auto-hide at rest, transient system
  overlays, full-screen/windowed transitions, external displays and keyboard use.

No commit/push, CI/CD changes, or deferred account-isolation task 247 work.
