# Move terminal CLI ownership out of Tessera

Status: complete

## Request

Remove the audio and file OSC CLI programs now maintained in an independent
repository. Keep Tessera's audio and file OSC protocols and browser support.

## Scope

- Remove both command packages and their CLI tests and unused dependencies.
- Stop building, vetting, uploading and requiring CLI release assets here.
- Keep protocol documentation; remove local CLI build/release instructions.
- Let the integration smoke scripts use an externally supplied helper binary.
- Preserve unrelated working changes and legacy updater compatibility assets.

## Validation

Run release asset tests, smoke-script syntax checks, Go tests and vet. Confirm
no active build instructions refer to the removed command packages.

## Implementation and results

- Deleted both CLI command packages and their tests. `go mod tidy` removed the
  now-unused `golang.org/x/term` dependency.
- Removed CLI vet/build/upload steps from CI. Release validation requires the
  four Tessera server binaries; legacy updater compatibility assets remain.
- Updated README, architecture, native desktop and OSC docs to describe external
  CLI ownership. Wire protocols and server/browser implementations are unchanged.
- Audio/file integration smoke scripts now require `--helper` pointing to an
  external CLI binary and build only Tessera locally.
- `go test ./...` and `go vet ./...` pass. All 585 JavaScript/core/script/Firefox
  bridge tests pass, including release manifest and invalid asset checks.
- Both smoke scripts pass syntax checks and reject a missing `--helper` before
  loading Playwright or launching a server. Full browser smoke runs were not
  performed because external CLI binaries were not supplied.
- Existing unrelated working changes were preserved. No commit or push made.
