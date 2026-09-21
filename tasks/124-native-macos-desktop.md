# Task 124: Additional native macOS build

Status: implemented; macOS compilation and interactive validation pending

Implement the user-approved native desktop plan, macOS first with private
loopback HTTP. Keep the existing webserver executable, flags, deployment,
dependencies and release workflow intact. Share the embedded frontend and backend.

Use a desktop-only Cocoa/WKWebView entry point with native window/menu/file
integration. Protect every local request with an in-memory per-launch capability,
disable additional listeners and server administration, isolate desktop storage,
and close managed work when the native app quits. Package a separate macOS app.

Validate server compatibility, desktop request policy, and desktop profile
behavior with automated tests. Add a macOS build workflow and explicitly record
which native checks cannot run on the Windows development host.

## Implementation

- Added tagged `cmd/tessera-desktop` and direct Cocoa/WKWebView host; no new Go
  module dependency or change to server deployment/release entry points.
- Added private desktop request policy, saved-HTTPS bypass, separate stable-origin
  profile, credential rotation, native menus/file dialogs, and save-before-quit.
- Added an ad-hoc signed `.app`/ZIP build script and independent macOS preview CI.
- Added policy, profile, streaming, WebSocket, SSE shutdown and frontend close tests.

Full Go and frontend suites, `go vet`, and the Windows server build passed.
The native target cannot be compiled or run on this Windows host; the documented
macOS validation gate remains open. See `docs/native-desktop.md` for instructions
and the interactive acceptance checklist.
