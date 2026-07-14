# Task 019: Platform release builds

Status: complete

Restore release builds for Windows, macOS, and Linux after adding native tray
controls.

- Keep the native notification-area tray on Windows and macOS.
- Build Linux without tray support so its release remains CGO-free and does
  not require GTK or AppIndicator libraries.
- Default `-tray` according to platform support and continue server-only when
  tray support is unavailable.
- Build Windows, macOS Intel, macOS ARM, and Linux on matching GitHub-hosted
  runners with the CGO setting required by each platform.
- Preserve the existing release asset names used by Tessera's self-updater.
- Document the platform-specific tray behavior and verify tests plus Windows
  and Linux release-style builds.

Implemented native tray build tags for Windows and macOS plus a server-only
stub for Linux and other unsupported platforms. The release workflow now uses
native Windows, macOS Intel, macOS ARM, and Linux runners with per-platform CGO
settings and shell-neutral artifact paths. Linux's dependency graph excludes
`github.com/getlantern/systray`; Windows and Linux release-style builds pass,
as do `go test ./...`, `go vet ./...`, the frontend syntax/language checks, and
the frontend bundle build.
