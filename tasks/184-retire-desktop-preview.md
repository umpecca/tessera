# Task 184: Retire the macOS desktop preview

Status: complete

## Request

Remove the Tessera Desktop macOS preview app; it does not fit the intended use.

## Changes

- Deleted `cmd/tessera-desktop`, `internal/nativeapp`,
  `scripts/build-desktop-macos.sh`, `.github/workflows/desktop.yml`,
  `docs/native-desktop.md` and `docs/native-desktop-plan.md`.
- Deleted the server's desktop-only request policy
  (`internal/server/native_policy.go`) and the `DesktopToken` option. The
  server now always loads saved Local HTTPS settings, as it already did
  outside desktop mode.
- Deleted `web/native-desktop.mjs` (the native quit bridge) and removed the
  `__tesseraDesktop` checks that hid Local HTTPS and Update Server; they were
  always false in a browser.
- Cleaned references from README, ARCHITECTURE, `docs/terminal-files.md`,
  `web/embed.go`, `.gitignore` and `internal/httpapi/api.go`.
- Kept `internal/desktop`, which is the server's system-tray controller.
- Kept task 124 as history.

## Validation

- `go build`, `go vet` and `go test ./...` pass.
- No remaining references outside `tasks/` and CHANGELOG history.
- Full JavaScript suite passes (562 tests, run with task 187).
