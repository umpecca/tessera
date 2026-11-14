# Task 265: Hide the idle iPad app menu

Status: implementation and automated verification complete; physical-device acceptance pending (2026-11-12).

## Request

Hide the native iPad app's top-right ellipsis button when unused so the workspace stays visually clear.

## Scope

- Fade the app-menu button away after five seconds without menu interaction.
- Keep a small, invisible touch target in the same top-right corner to reveal the button again; do not reveal it for ordinary typing, scrolling or workspace touches.
- Keep menu interactions usable without timing out an open menu, and retain an accessible menu for VoiceOver users.
- Preserve the workspace layout, terminal focus and connection; no web/Safari or Mac UI changes.
- Add regression coverage and update the Apple app documentation and changelog.
- Approval: user confirmed the proposed five-second fade/corner reveal/VoiceOver behavior with “yes” (2026-11-12).

## Acceptance criteria

- [x] The idle ellipsis button disappears after five seconds.
- [x] Tapping its corner reveals it; normal workspace interaction does not reveal it or reset the timeout.
- [x] The menu stays usable while open; VoiceOver/Switch Control disable expiry in the tested policy (physical assistive-technology acceptance below).
- [x] Hiding/revealing does not reload, resize or steal focus from the workspace.
- [x] Relevant automated checks pass; simulator and physical-device acceptance are recorded separately.

## Verification

- Intended: Swift package policy tests, targeted native iPad simulator UI regression, iPad and shared Mac build checks, and `git diff --check`.
- Physical iPad touch/VoiceOver acceptance remains separate from automated or simulator checks.
- `swift test --package-path apple/TesseraCore`: 29 tests passed in five suites, including four new idle-menu policy regressions.
- Mac unsigned build: passed with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -quiet -project apple/Tessera.xcodeproj -scheme Tessera -destination 'platform=macOS' -derivedDataPath …/T/opencode/tessera-idle-menu-mac build CODE_SIGNING_ALLOWED=NO`. Initial invocation without `DEVELOPER_DIR` failed because the machine's selected developer directory is Command Line Tools; no system configuration was changed.
- iPad device Release build: passed with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -quiet -project apple/Tessera.xcodeproj -scheme Tessera-iPad -destination 'generic/platform=iOS' -configuration Release -derivedDataPath …/T/opencode/tessera-idle-menu-ipad-release build CODE_SIGNING_ALLOWED=NO`. This is an unsigned build, not a physical-device test or installation.
- Initial targeted iPad test build caught Swift actor isolation errors in timer cleanup/callbacks; corrected with main-run-loop isolation and explicit view teardown cancellation. The next simulator run confirmed idle decoration disappearance and a working corner reveal but exposed a fixture assertion assuming that tapping an already-focused WebKit field never selects its text. The test now captures the post-touch text/caret baseline before testing reveal focus preservation.
- Full native iPad UI suite: **8/8 passed, 0 failed**, using `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/apple-ipad-tests.mjs --output=…/T/opencode --derived-data=…/T/opencode/tessera-ipad-ui-eLQpS5/DerivedData`. Result: `…/T/opencode/tessera-ipad-ui-fpY9IC/Results.xcresult`. Covers actual idle hiding/reveal, typing without a reset or focus loss, open-menu timing, selection/outside dismissal, unchanged page/viewport, foreground reveal, plus all existing native profiles/privacy/full-screen/keyboard/download/accessibility-description regressions. Generated loopback fixtures on a disposable iPad simulator; not a live Tessera server or physical device.
- Inspected the exported simulator screenshot `…/T/opencode/tessera-idle-menu-attachments/A1F4C012-D27B-4B99-A427-FD4479C8E5F0.png`: no visible ellipsis or material remains at idle.
- Repeated Swift tests with explicit Xcode `DEVELOPER_DIR`: 29/29 passed without the Command Line Tools linker-path warnings from the first run.
- `git diff --check`: passed after implementation and test correction.

## Implementation notes

- The native control is `appMenu` in `apple/Tessera/IPadRootView.swift`.
- Existing task 251 covers the shipped iPad app/full-screen behavior; this task isolates the new idle-menu interaction.
- Implementation started after approval.
- Added `IdleAppMenu` policy and a native `UIButton` wrapper in `apple/Tessera/IPadAppMenu.swift`. Public UIKit menu lifecycle callbacks prevent expiry while open and restart the timer after selection or outside dismissal. All existing menu commands are preserved in `IPadRootView`.
- The button stays 44×44 and hit-testable while only its image/material decoration fades. Menu updates and ordinary workspace activity do not restart the timer. Foreground entry reveals it. VoiceOver and Switch Control disable auto-hiding; Reduce Motion skips the fade animation.
- Updated `apple/README.md` and `CHANGELOG.md`.
- Added simulator coverage for hide/reveal, keyboard focus/viewport/document preservation, ordinary interactions, held-open menus, selection/outside dismissal and foreground return. Physical accessibility and touch acceptance still required.
- No commit/push, app installation, IPA packaging or unrelated task work performed.

## Physical-device acceptance pending

- [ ] Confirm five-second fade/corner reveal and normal typing/scrolling on a physical iPad, including rotation and Split View/Stage Manager.
- [ ] Confirm enabling VoiceOver/Switch Control reveals and retains the control, menu navigation works, disabling them restarts expiry, and Reduce Motion skips the fade.
