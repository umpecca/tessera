# Task 252: Native iPad privacy shield and optional device lock

Status: implementation and automated verification complete; physical-device acceptance pending.

## Scope

- Default-on opaque app-switcher cover, including native sheets and app windows.
- Optional device-owner authentication on cold launch and return from genuine
  backgrounding, with Face ID/Touch ID/iPad passcode through LocalAuthentication.
- Device-local settings, authenticated enable/disable, explicit retry after
  cancellation, no automatic-prompt loop and rejection of stale replies.
- Keep existing web content alive beneath a background lock. Cold launch delays
  saved-server web-view creation until first unlock. Host shells keep running.
- Preserve distraction-free full-screen presentation and windowed multitasking.

## Boundaries

- No private WebKit/UIKit APIs, custom PIN or stored biometric credentials.
- A synchronous scene-deactivation observer installs opaque covers directly in
  existing app windows; a separate native window provides generic lock/retry UI.
- Locked input belongs to the lock window, not the terminal responder. Native
  app actions and native clipboard requests reject access while locked.
- Permission/authentication-sheet inactivity covers the preview but does not
  create a fresh lock. Real backgrounding invalidates authentication and native
  clipboard consent. Authentication success after invalidation is ignored.
- Preview protection is not encryption, server authentication or screenshot
  prevention while unlocked. Shared clipboard and system-owned UI/notifications
  are not erased or controlled by this feature.
- Deterministic authentication responses require DEBUG + simulator + isolated
  UI-test launch arguments. Release builds always use LocalAuthentication.

## Automated verification

- Core state-machine tests: defaults, transient inactivity, cold-launch gating,
  authenticated setting changes, cancelled automatic unlock/manual retry,
  background invalidation/stale replies and lock protection with preview opt-out.
- Native UI tests: opaque preview over a native sheet, hidden accessibility,
  unchanged document on return, cancellation, successful retry, cold-launch
  gating and persisted enable/disable. Device authentication responses in these
  UI tests are simulated, not evidence of real biometric/passcode verification.
- Regression coverage includes full-screen default/persistence, rotation,
  profiles, downloads, key row and accessibility.

## Verification evidence (2026-11-10)

- **25 Swift tests in five suites passed**, including the privacy state machine.
  Log: `tessera-ipad-privacy-core-tests.log`.
- **6/6 native UI tests passed**, covering privacy previews over a sheet, cancelled
  setting changes/unlocks, manual retry, background and cold-launch protection,
  persisted settings, fullscreen/rotation, profiles, downloads, keys and accessibility.
  Results: `tessera-ipad-ui-S1yRf9/Results.xcresult`;
  log: `tessera-ipad-privacy-ui-final.log`. Authentication results are injected in
  these DEBUG simulator tests, not real Face ID/passcode acceptance.
- **1,045 JS tests passed**, `tessera-ipad-privacy-js-tests.tap`.
- Final background-lock/snapshot regression after the sizing/suspension cleanup:
  **1/1 passed**, `tessera-ipad-ui-zlHLOL/Results.xcresult`;
  log: `tessera-ipad-privacy-lock-regression.log`.
- Real WKWebView/native clipboard smoke passed, including generated Unicode/PNG
  writes over HTTP, iframe/proxy denial and pending-consent navigation invalidation.
  Log: `tessera-ipad-privacy-clipboard-smoke.log`.
- Mac build and unsigned iPad Release packaging passed. Final IPA metadata verifies
  **0.2 (5)**, iPad-only device family, Face ID usage description and no DEBUG
  authentication-injection strings in the Release executable.
- Artifact: `…/T/opencode/tessera-ipad-0.2-privacy.ipa`. Sign/install over the
  existing app without deleting profiles, downloads or sign-ins.

## Physical-device acceptance still required

- [ ] Real app-switcher snapshots while terminal/server/download sheets are open.
- [ ] Face ID/Touch ID success/failure/cancel and system passcode fallback.
- [ ] Lock/unlock, Home/return, Control Center and permission-sheet transitions.
- [ ] Hardware keyboard/IME cannot reach a locked terminal; unlock does not
  automatically focus an editable field.
- [ ] Stage Manager/multiple windows, external display and accessibility.

No server authentication changes, personal clipboard reads or commits/pushes.
