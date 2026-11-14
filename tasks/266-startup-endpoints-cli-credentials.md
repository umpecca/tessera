# Task 266: Startup endpoints and CLI sign-in credentials

Status: complete (2026-11-12).

## Request

Make server connection addresses and sign-in configuration easier to remember: print HTTP/HTTPS endpoints to stdout at startup and allow a CLI username/password instead of the accounts configured in Settings.

## Scope

- Print a concise startup summary to stdout after listeners start successfully: actual HTTP URL, actual Local HTTPS URL or an explicit disabled state, and effective sign-in mode/user names. Never print passwords, credential hashes or recovery tokens. Keep operational errors on stderr.
- Print updated endpoints after a successful Local HTTPS listener reload; preserve existing listener, host-validation and certificate behavior. Do not automatically enable HTTPS or invent reverse-proxy URLs.
- Add `-username` and `-password` for a single runtime sign-in account, plus a safer `-password-stdin` alternative. Explain that argument passwords can appear in shell history/process listings.
- CLI credentials override the saved sign-in mode and account credentials only while supplied, without overwriting saved accounts, passwords or sign-in preferences. The override account can administer the running server, but Settings cannot change the CLI-owned sign-in mode/credentials.
- Reject incomplete/empty credentials and incompatible combinations (including conflicting explicit auth modes or the legacy user roster). Fail closed: stored accounts and their existing sign-ins must not bypass the runtime override. Keep HTTPS/HTTP password-transport restrictions and login throttling.
- Preserve normal saved-account behavior when the override flags are absent. No OS-account switching, workspace migration, or unrelated auth redesign.
- Add focused CLI/server/auth regressions and update CLI/product documentation and `CHANGELOG.md`.
- Include an early README example using a specified hostname, HTTP/HTTPS endpoints and `-username` with `-password-stdin`; distinguish enabling HTTPS from allowing a hostname.
- Approval: user explicitly approved implementation and run-only superseding credentials, and requested the README example (2026-11-12).

## Acceptance criteria

- [x] Successful startup emits HTTP/HTTPS endpoint information on stdout using actual bound ports, including IPv6 and ephemeral-port cases; disabled HTTPS is clearly labeled.
- [x] The summary identifies effective sign-in configuration without disclosing secrets; successful listener reloads report updated endpoints.
- [x] A supplied CLI username/password works instead of saved credentials for that run, and Settings cannot silently replace it.
- [x] Partial/invalid/conflicting credential flags fail safely; stdin provides a non-argument password option.
- [x] Saved sign-in preferences and account credentials remain unchanged; saved-account sign-ins cannot bypass the override, and normal behavior returns when it is removed.
- [x] Relevant tests pass and documentation explains precedence, security implications and examples.

## Verification

- Intended: affected `cmd/tessera`, `internal/server`, `internal/desktop` and `internal/httpapi` package tests; broader `go test ./...` and `go vet ./...` as appropriate.
- Add subprocess or generated-fixture checks for stdout/stderr separation, runtime credential precedence, sign-in/session isolation, saved-state preservation, listener reloads and secret redaction.
- `git diff --check`; distinguish mocked/automated checks from any live-server acceptance.
- Initial affected packages: `go test ./cmd/tessera ./internal/server ./internal/httpapi ./internal/desktop` passed.
- `node --test web/sign-in-settings.test.mjs`: 4/4 passed, including the CLI-owned settings view with no saved-account mutation controls.
- `node --test web/*.test.mjs`: 1,052/1,052 passed.
- `npm run build:web`: passed. It regenerated the clipboard development ZIP with unchanged entry contents; verified entries byte-for-byte and restored only that generated timestamp-only difference.
- Final `go test ./...` and `go vet ./...`: passed after additional host-cookie/empty-database/invalid-subprocess coverage.
- `go test -race ./cmd/tessera ./internal/server ./internal/httpapi`: passed (5.4s / 11.3s / 40.7s respectively).
- CLI entry-point subprocess tests verify successful stdin-password sign-in over a real ephemeral loopback listener, allowed hostname handling, stdout/stderr separation and credential redaction. Invalid/incomplete/conflicting flag subprocesses exit before opening a database and emit no endpoint summary.
- `git diff --check`: passed; final repository status preserves prior iPad work and unrelated untracked files.

## Implementation notes

- Current startup output is `log.Printf("Tessera listening at %s", controller.URL())` in `cmd/tessera/main.go`, which reports HTTP only on stderr.
- `server.Server` already exposes actual HTTP/HTTPS endpoints. `desktop.Controller` currently exposes only HTTP.
- Existing `-auth` deliberately persists the chosen mode; the new run-only credential override must bypass that persistence rather than accidentally modifying Settings.
- Existing `tessera user` commands manage saved accounts and remain unchanged. This task is distinct from deferred OS-account isolation tasks 244/247 and native Mac host management task 264.
- Preserve the prior iPad task's uncommitted work and other unrelated files.
- Added `credentialFlags` parsing/hashing in `cmd/tessera/credentials.go`, plus `-username`, `-password` and bounded first-line `-password-stdin`. Plaintext buffers are cleared; incomplete/conflicting inputs fail before opening the database. Errors do not echo credential values.
- `AuthOptions.RuntimeAccount` selects a single in-memory admin account, always locks sign-in mode, and bypasses both saved account lookup and saved-mode persistence. Startup also skips legacy-account import while the override is active.
- CLI cookies use a separate credential-tag namespace plus the salted runtime hash. Saved file/host cookies cannot pass, even with an identical account name/hash; CLI cookies cannot authenticate after removing the override or generating a new process's hash. Existing saved sign-ins are not implicitly revoked.
- Account management endpoints reject mutation during the override; settings describe CLI ownership and hide dormant saved-account controls. Recovery links can name only the active CLI account. Transport restrictions and throttling remain shared with normal sign-in.
- `server.Options.StartupOutput` reports after successful listener starts and reloads, including tray restart/recovery, without needing new desktop-controller accessors. The CLI passes stdout; errors stay on stderr. Summaries show actual ports and enabled HTTPS's certificate hostname; no reverse-proxy endpoints are guessed.
- Added an early root README hostname/HTTP/HTTPS and hidden-prompt stdin example, CLI flag listings, detailed sign-in documentation, and a changelog entry. Allowing a hostname does not enable HTTPS; existing Local HTTPS configuration is retained.
- Documented limitation: a consumed stdin password cannot be replayed by automatic self-update replacement. Supply it again on manual restart after updating. New early credential failures signal the existing replacement-failure handshake so the original process can restore its CLI-protected server, never a saved-account fallback. No self-update handoff was manually exercised for this task.
- Automated checks use temporary databases/generated credentials, real loopback listeners (including HTTPS/IPv6), recorder-based auth tests and a subprocess of the CLI entry point. No personal server credentials, existing databases or remote devices were used. No browser/physical-device acceptance is claimed.
- No commit, push, installation or unrelated task implementation performed. Optional manual acceptance remains for a real deployment's DNS, certificate trust, browser sign-in and documented self-update/stdin recovery limitation; these are not claimed by automated fixture checks.
