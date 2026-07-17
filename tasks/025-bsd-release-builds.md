# Task 025: BSD release builds

Status: complete

Add release artifacts for FreeBSD and OpenBSD on amd64.

- Cross-compile both BSD targets on a GitHub-hosted Linux runner.
- Keep the builds CGO-free and server-only, matching other unsupported-tray
  platforms.
- Publish artifacts using Tessera's existing `tessera-${GOOS}-${GOARCH}` naming
  contract so the self-updater can discover them.
- Document the additional release assets and verify both targets compile.

Implemented by adding FreeBSD amd64 and OpenBSD amd64 entries to the release
matrix. Both targets cross-compile on `ubuntu-latest` with `CGO_ENABLED=0`, use
the unsupported-platform desktop stub, and retain the updater-compatible
artifact names. The README release list and platform behavior notes now include
both BSD builds.

Verification:

- `GOOS=freebsd GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/tessera`
- `GOOS=openbsd GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/tessera`
- `go test ./...`
