# Task 248: Incremental frontend modularization

Status: complete (2026-11-09). All application feature logic has been extracted;
`web/app.js` is 434 lines of composition and startup only. Final verification passed.

## Request

Reduce the responsibility and shared mutable state in `web/app.js` without
changing the interface, introducing a frontend framework or rewriting the app.
Extract coherent controllers with explicit dependencies and test their modules
directly rather than slicing their implementation out of the application source.

Account isolation (task 247) remains deferred. CI/CD stays unchanged.

## First slice: workspace and settings persistence

- `web/workspace-persistence.mjs`: owns workspace revision, save timer and queue,
  in-flight/exit revisions, acknowledged archived content, conflict suspension
  and reconnect revalidation. The app supplies fresh documents, a loading check,
  status updates and conflict presentation; the controller owns no pane DOM.
- `web/settings-persistence.mjs`: owns the independent per-account settings
  revision, dirty state, debounce, serialized save drain and exit save.
- `web/workspace-document.mjs`: pure workspace serialization, preserving pane
  ordering, geometry, type-specific settings and opaque retired-editor content.
  Only acknowledged content is omitted from layout-only saves. Credentials and
  live view objects never enter the serialized document.
- `web/app.js`: composes the controllers, resets them on workspace/account load
  and retains small adapters for UI events, session navigation and phone refresh.
  Returning to the user picker clears the settings controller's account.
- Loading a new document advances a controller generation. Delayed responses
  and completion handlers cannot change the next document's revision, save
  queue, in-flight token or conflict state.
- New modules are explicitly embedded in the Go binary and covered by the
  existing versioned-module resolution test. No generated vendor bundle changes
  are required by these application-module imports.

## Behavior to preserve

- Debounced autosave sends current state, not a stale captured document.
- Saves serialize, and navigation waits for the full drain of queued edits.
- Workspace conflicts pause saving; disconnections require revision
  revalidation before queued saves resume.
- Settings failures retain dirty state and reject navigation flushes.
- Exit saves can supersede their own pending revision and include content
  changed then reverted since the last acknowledgement.
- Oversized workspace documents are attempted without keepalive, never trimmed.
- Existing API fields, archived content and phone/desktop settings behavior stay
  unchanged. This refactor does not implement task 246's settings-conflict fix.

## Validation

- Direct-import tests for both persistence controllers and workspace documents:
  debounce, save ordering, failures, conflicts, reconnect, exit-save ordering,
  UTF-8 size limits, reset races and document/credential boundaries.
- Existing session-navigation tests remain to cover the application glue.
- Run the full JavaScript suite, syntax checks, Go tests and vet, web bundle
  build, and embedded-module resolution checks.
- Browser smoke check with a temporary server/database: startup, live terminal,
  geometry autosave/reload, settings autosave/reload and two-page conflicts.

Passed on macOS (2026-11-09): all 932 JavaScript tests, `go test ./...`,
`go vet ./...`, `npm run build:web`, syntax and embedded-module checks. The
headless Chromium smoke check passed against the built binary's embedded
assets, including preservation of archived content, with no uncaught browser
errors. Generated vendor bundles stayed unchanged.

## Controller and dialog slices

- `web/terminal-connections.mjs`: socket generations, replay URL/attachment,
  message dispatch, retry/backoff and sign-in recovery. Terminal focus, sizing,
  startup input, alerts and audio/file presentation remain explicit app hooks.
- `web/browser-controller.mjs`: latest-request-wins navigation, proxy capability
  release, disposal and clear-site-data confirmation/reload. Frame event routing
  and pane mounting remain in the application.
- `web/vnc-controller.mjs`: noVNC loading, connect/disconnect/dispose, preferences,
  controls and clipboard transfer. Pending attempts and stale connection events
  cannot update replacement panes. Dialogs and clipboard access are callbacks.
- `web/rdp-controller.mjs`: proxy requests, shared short-lived kept-session
  listings scoped to account/workspace, captured-workspace lookup and teardown.
  Detach/dispose leave host sessions alive; explicit disconnect ends them.
  Invalidating a listing retains known host capability for pane-deletion cleanup;
  late listings cannot overwrite a newer capability check.
  Connection dialogs, IronRDP rendering and kept-viewer reattachment remain app
  effects rather than being coupled to request/cache ownership.
- `web/settings-dialog.mjs`: settings layout, focus containment/restoration,
  scroll/disclosure retention and diagnostics timer/metrics ownership. App row
  builders and preference actions are supplied explicitly.
- Settings-modal tests now import `SettingsDialog`; Browser async navigation,
  terminal replay/backoff/color and RDP detach/disconnect tests import controllers.
  Hidden-output integration fixtures retain only application-effect source
  helpers and use the actual transport controller with the real replica.
- Added direct regression coverage for stale sockets and VNC events, delayed
  clipboard reads, proxy errors, sign-in recovery/disposal, Browser capability
  release/site-data reload, RDP cache identity/expiration and full teardown.

Controller-slice validation: all 949 JavaScript tests, `go test ./...`,
`go vet ./...`, `npm run build:web` and syntax checks for all extracted modules
passed. Embedded-module coverage follows transitive and lazy imports as well as
the app entry point. Generated vendor bundles and release workflows are unchanged.
Headless Chromium passed against the rebuilt binary's embedded assets: live
terminal startup/reconnect, geometry and archived-content autosave/reload, settings
focus trapping/diagnostics and theme persistence, two-page workspace conflicts,
and a real loopback Browser proxy loading, navigating and clearing site data.
No uncaught browser errors occurred. VNC/RDP controller tests use fake transports;
no live remote-desktop server was used for this validation.

## Completed application boundaries

The user's final directive was to finish all frontend modularization, not stop
at controller slices. All 467 remaining application functions are now in 29
concrete feature modules. `web/app.js` contains only explicit dependency wiring,
ordered initialization and the startup call (under 500 lines).

- Desktop: `desktop-panes.mjs`, `desktop-geometry.mjs`,
  `desktop-interactions.mjs` own pane construction/destruction, selection, titles,
  fonts, docking/maximize/arrange and pointer/keyboard interactions.
- Navigation/workspace: `session-navigation.mjs`, `workspace-lifecycle.mjs`,
  `workspace-background.mjs` own account/session transactions, restoration,
  persistence UI and background upload/display.
- Pane views: `browser-view.mjs`, `vnc-view.mjs`, `rdp-view.mjs`,
  `rdp-session.mjs`, `rdp-dialogs.mjs`, `terminal-view.mjs`,
  `terminal-input-bridge.mjs` separate mounting/input/dialogs from the existing
  transport/rendering controllers. `phone-workspace.mjs` owns phone integration.
- Preferences/settings: `preferences.mjs` owns settings values/storage/effects;
  `settings-view.mjs` owns row builders/diagnostics and composes `SettingsDialog`.
- UI: `workspace-menus.mjs`, `deskbar.mjs`, `command-palette.mjs`,
  `window-list-view.mjs`, `session-list-view.mjs`, `window-switcher-view.mjs`,
  `sessions-dialog.mjs`, `directory-dialog.mjs`, `local-https-dialog.mjs`,
  `help-dialog.mjs` own their DOM, navigation and focus behavior.
- Integration: `clipboard-access.mjs`, `server-connectivity.mjs`,
  `application-events.mjs` own clipboard fallback/saving, connection/wake/update
  recovery and browser/desktop event registration.

Factories own state per instance and take explicit, documented lazy feature
providers plus browser capabilities. They perform no effects until their
initialization/action methods run. There is no generic shared-state container,
global service registry, dynamic source evaluation, framework or new build step.
Initialization order remains explicit, with startup after all feature state,
DOM and listeners are ready.

All application scenario tests now import actual factories. The test-only
`application.test-support.mjs` adapts old fixture mocks onto the owning features;
it does not read or execute source slices. Existing upstream/vendor, early
startup-script and server-injected-script tests keep their specialized fixtures.
`frontend-modules.test.mjs` checks factory isolation, side-effect-free construction,
dependency/member wiring and the composition-root boundary. RDP connection tests
cover trust refusal, credentials, stale completions, original-workspace cleanup
and cancellable dialogs. RDP requests capture identity before awaits and cannot
rejoin or clean up sessions belonging to a replacement workspace.

`scripts/frontend-smoke.mjs` is a repeatable browser check against embedded
assets, without injecting application internals. Existing shortcut/audio/file
smoke instrumentation now addresses feature-owned APIs. The Go shortcut-code
parity test reads the command-palette module rather than the former monolith.

## Final verification

- Full JavaScript suite: **960 passed, 0 failed** (including native-core tests).
- `go test ./...`: passed, including transitive/versioned embedded-module tests.
- `go vet ./...`: passed.
- `npm run build:web`: passed; generated vendor bundles unchanged.
- Syntax checks: **237 JavaScript modules/scripts passed**.
- `git diff --check` and Go formatting checks: passed.
- Chromium shortcut smoke: passed CRUD/duplicate, palette invocation before and
  after reload, literal CLI values and working directory, optional/boolean
  switches, no startup-command rerun on restore, cancellation, draft testing and
  concurrent-save conflict preservation.
- Embedded-asset Chromium frontend smoke: passed terminal startup, geometry and
  archived-content autosave/reload, Settings focus/diagnostics/theme persistence,
  terminal reconnect without focus theft, two-page conflicts, terminal creation
  and cleanup, maximize/restore and Window List, real loopback Browser proxy
  navigation/site-data clearing, and phone terminal list/open/back navigation.
  No uncaught browser errors occurred.
- Live VNC/RDP servers and external audio/file CLI helpers were not used for
  these browser checks; their protocol/controller/core regression tests passed.
  This is a validation limitation, not remaining modularization work.

No commits or pushes were made. Account isolation (task 247) remains **TBD / later**;
tag-triggered CI/CD, package dependencies and generated vendor bundles are unchanged.
