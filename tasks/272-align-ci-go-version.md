# Task 272: Align CI and local Go versions

Status: complete (2026-11-14).

## Request

The v1.16.1 tag's CI run (43645745108) failed at "Committed generated files
match the build": `web/extensions/tessera-clipboard-dev.zip` differed. The
extension sources inside the zip were identical; only the deflate bytes
differed because the commit was packaged with local Go 1.27.4 while CI installs
Go 1.26.1 from `go.mod`. The user chose to update Go so CI and local builds use
the same toolchain.

## Scope

- Bump the `go` directive in the root `go.mod` from `1.26.1` to `1.27.4`.
  `actions/setup-go@v5` with `go-version-file: go.mod` reads only the `go`
  directive (not `toolchain`), so this is what selects the CI version.
- Update the Go version mentioned in `ARCHITECTURE.md`.
- Out of scope: the separate `scripts/latency-check` module, changing the
  packager's compression, re-tagging or releasing.
- Approval: user directed "update go so CI local builds use the same"
  (2026-11-14).

## Acceptance criteria

- [x] Root `go.mod` declares `go 1.27.4`.
- [x] Rebuilding the clipboard package with Go 1.27.4 reproduces the committed
      `tessera-clipboard-dev.zip` byte-for-byte.
- [x] `go build ./...`, `go vet ./...` and `go test ./...` pass on Go 1.27.4.
- [x] CI on the next tag passes the generated-files check.

## Verification

- `go mod tidy`: no `go.sum` changes.
- `npm run build:clipboard` on Go 1.27.4: `git status` shows no drift in `web/`.
- `go build ./...`, `go vet ./...`: pass (Go 1.27.4, darwin/arm64).
- `go test ./...`: all packages pass.
- `GOOS=linux GOARCH=amd64|arm64` and `GOOS=windows GOARCH=amd64` with
  `CGO_ENABLED=0 go vet ./cmd/tessera`: pass.
- GitHub Actions run 43647305604 on retagged v1.16.1 (`562923f`): all jobs
  passed; release published with 4 assets.

## Implementation notes

- Changed files: `go.mod`, `ARCHITECTURE.md`. No changelog entry: this changes
  only the build toolchain, nothing users see.
- Confirmed before the change: packager built with Go 1.27.4 matches the
  committed zip (5633 bytes); built with Go 1.26.1 it produces 5593 bytes, as
  CI did.
