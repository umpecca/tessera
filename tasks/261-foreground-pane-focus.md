# Task 261: Restore active-pane focus on foreground

Status: complete (2026-11-11); physical-device acceptance deferred as approved.

## Request

When the native iPad app gains focus, automatically restore keyboard/text focus
to the current foreground pane without requiring a mouse click. Provide the
same best-effort behavior for a web app installed on the Home Screen.

## Scope

- Audit native resume and browser lifecycle focus handling; share a guarded
  focus-restoration path rather than focusing on reconnect/layout updates.
- Restore only a visible current pane on foreground/focus transitions. Respect
  dialogs, menus, existing control focus, native privacy/presentation state,
  phone non-typing modes and user interactions that supersede a pending restore.
- Use existing pane focus APIs, without raising/saving panes, injecting input,
  forcing reloads, clearing terminal selection/history or claiming a shell resize.
- Use public native responder APIs only if needed, preserving privacy/origin checks.
- Cover native resume plus visibility/window-focus/BFCache events for installed
  web apps. Do not promise software-keyboard activation where iPadOS restricts it.
- Add regression/browser checks, document platform limits, defer physical iPad
  and installed-Home-Screen acceptance honestly. No active test-server restart.
- Approval: the user requested this behavior for native iPad and Home Screen use,
  then explicitly directed retrying the request.

## Acceptance criteria

- [x] Foreground restoration reaches the current visible active pane without a
  click on native/web lifecycle paths, with bounded retries where needed.
- [x] Dialogs, native privacy/UI, unrelated form fields, phone Scroll/Select modes
  and intervening user choices are not overridden.
- [x] Reconnects, resize/layout and ordinary polling do not request restoration;
  focus restoration itself sends no synthetic input/Enter, claims no shell size
  and does not change the active pane.
- [x] Relevant automated/native build checks pass and docs/changelog reflect the
  behavior and separate physical-device/software-keyboard limits.

## Verification

- `node --test web/*.test.mjs`: 1,040 passed, zero failed. Includes inert-factory
  composition, focus policy/cancellation, standalone detection, remote/browser
  focus targets, native resume authorization and native UI-hold cancellation.
  Log: `$TMP/task261-web-tests-final.txt`.
- `node scripts/foreground-focus-smoke.mjs --binary=$TMP/tessera-foreground-W4Cn1L/tessera
  --playwright=$TMP/tessera-browser-cUa7BM/node_modules/playwright/index.mjs
  --output=$TMP/tessera-foreground-W4Cn1L/browser-find`, with
  `PLAYWRIGHT_BROWSERS_PATH=$TMP/tessera-browser-cUa7BM/browsers`: all six cases
  passed (Chromium 158.0.8127.18 and WebKit 27.2, each with ordinary, standalone
  and native-style detection). Real embedded terminal DOM; simulated lifecycle
  and native/installed flags. Settings, unrelated fields and blurred terminal
  Find remain protected; pane z-index unchanged; no focus-only shell resize or
  synthetic input. Ordinary tabs and non-foreground native resumes do not focus.
- Initial browser run caught the missing explicit Go embedding of the new module;
  fixed in `web/embed.go` and rebuilt. A subsequent attempted headless tab switch
  emitted no lifecycle events; the smoke now explicitly dispatches lifecycle
  events rather than claiming a real app/window switch. BFCache also exercises
  existing wake/reconnect handling: socket grid negotiation is separate from
  focus-only no-resize assertions, not disabled or represented as a focus side effect.
- `node scripts/frontend-smoke.mjs` with the same binary/Playwright and output
  `$TMP/tessera-foreground-W4Cn1L/frontend`: passed. Covers embedded module startup,
  Settings, autosave/reload, reconnect without focus theft, independent fonts,
  conflict recovery, Browser panes, phone touch/compose/Select/Scroll/direct modes,
  narrow native layout and suspend/resume; no uncaught browser errors. Run before
  the final additional terminal-Find guard, subsequently covered by the focus smoke.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
  --package-path apple/TesseraCore`: 25 passed.
- `node scripts/apple-ipad-tests.mjs
  --only=testForegroundRequestsWorkspaceFocusButNotBehindNativeSheets,testPrivacyShieldCoversNativeSheetsAndPreservesTheWorkspace,testOptInDeviceLockRejectsCancellationAndProtectsBackgroundAndColdLaunch
  --output=$TMP/task261-native`: 3/3 passed in a disposable iPad simulator. Native
  foreground test types without a field tap and preserves page identity; native
  sheets suppress requests. Fixture is a generated web input/protocol page,
  not the complete terminal. Privacy shield/device-lock tests also passed.
  Result: `$TMP/task261-native/tessera-ipad-ui-PKLFj0/Results.xcresult`.
- `xcodebuild -quiet -project apple/Tessera.xcodeproj -scheme Tessera-iPad
  -destination 'generic/platform=iOS Simulator'
  -derivedDataPath $TMP/task261-native/tessera-ipad-ui-PKLFj0/DerivedData
  build CODE_SIGNING_ALLOWED=NO`: passed after the help-text update.
- `npm run build:web`, `go build -o $TMP/tessera-foreground-W4Cn1L/tessera
  ./cmd/tessera`, `go test ./...`, `go vet ./...` and `git diff --check`: passed.
  Go used `$TMP/tessera-go-1ovo0srj/go/bin/go` (on PATH for the web build).
- `$TMP` above is
  `/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode`.
- Physical iPad hardware/software keyboard, installed Home Screen app, Stage
  Manager/Split View, unlock/rapid switching and live RDP/VNC/browser acceptance
  remain in the combined `docs/performance-acceptance.md` checklist. Automated
  browser/simulator results do not establish these device results.

## Implementation notes

- Created before implementation. Investigation found native `suspend` explicitly
  blurred while `resume` restored history/connections but not input focus; browser
  focus events only reported terminal focus, without restoring its DOM target.
- Added lazy, inert `web/foreground-focus.mjs` controller, unit coverage and
  embedded-asset browser smoke. Existing pane focus APIs are used only for the
  active visible topmost pane, without selecting/raising/saving it or injecting
  clicks, keys or shell-size claims. Retries are limited to ten at 100 ms intervals.
- `web/application-events.mjs` handles installed-app focus, visibility and BFCache;
  pointer/key input, blur/pagehide and hiding cancel pending work. Ordinary browser
  tabs and embedded app frames are excluded. Dialogs/menus/screensaver, unrelated
  controls, DOM selection, open terminal Find and phone non-typing modes block it.
- `web/native-app.mjs` accepts explicit `restoreFocus: true` on foreground resume;
  suspend/native UI holds cancel retries. `web/app.js` supplies the dependencies.
- `IPadAppModel.resumeWorkspace(restoringFocus:)` checks active scene, privacy,
  native presentation, page readiness and server/document origin, then uses public
  `becomeFirstResponder()` and the explicit foreground payload. Page completion
  and unlock use the same path; network recovery/layout do not request focus.
  Native sheets, notices and import pickers cancel pending work through UI holds.
- Updated changelog, remote-access docs, native README/help and the combined manual
  checklist. Both updated native app and updated server are needed; reload the web
  app after updating its server. iPadOS software-keyboard activation is best-effort,
  not guaranteed and never bypassed with private APIs.
- No active server restart, commit or push. Existing unrelated work preserved.
