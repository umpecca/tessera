# Task 263: Remember RDP certificate trust across windows

Status: implementation and automated verification complete (2026-11-11);
real RDP login/graphics and physical-iPad acceptance remain in the combined block.

## Request

After explicitly accepting an RDP server certificate once, remember its SHA-256
fingerprint so reconnecting or opening another window does not ask again for the
same certificate.

## Scope

- Persist accepted certificate fingerprints in the Tessera server database,
  scoped to the current Tessera user and normalized RDP hostname/IP plus port.
  Reuse that approval across that user's windows, sessions and web/native clients.
- Preserve existing per-pane trust compatibility and investigate persistence paths
  before changing them. Do not weaken trust when pane and stored approvals differ.
- Continue probing certificates before credentials and pinning the actual RDP
  connection. Unknown targets require explicit acceptance; changed fingerprints
  show a warning and require explicit approval before replacing remembered trust.
- Never learn trust from a cancelled/stale dialog or a connection failure, and
  never persist RDP passwords. Different ports/targets and Tessera users remain
  isolated. Do not change TLS validation for the Tessera server itself.
- Add regression coverage for persistence/reload, cross-window reuse, changed
  certificates, cancellation and user isolation; update documentation/changelog.
- No active server restart, commit or push.
- Approval: user explicitly approved account-wide, target-scoped persistence
  with “yes” after reviewing the proposed scope.

## Acceptance criteria

- [x] Explicitly accepted certificates are reused for the same user/target after
  reload/restart and from a new window/session/client, without another trust prompt.
- [x] Unknown/changed certificates still require explicit consent before credentials;
  changed certificates are not silently accepted by either RDP connection mode.
- [x] Trust is isolated by user and normalized target/port; cancellation, stale
  attempts and failures cannot accidentally approve or replace certificates.
- [x] Relevant storage/API/web tests and builds pass; docs explain persistence,
  changed-certificate behavior and any deferred live-server acceptance.

## Verification

- `node --test web/rdp-session.test.mjs web/rdp-pane.test.mjs
  web/rdp-controller.test.mjs`: 40 passed during implementation.
- `node --test web/*.test.mjs`: final run 1,051 passed, zero failed. Log:
  `$TMP/task263-web-tests-final.txt`. Includes remembered/changed/legacy trust,
  cancellation, old-server fallback, failed/conflicting trust writes, and stale
  workspace/profile/signed-in-account/dialog completion protection.
- `go test ./internal/store ./internal/httpapi`, then final `go test ./...`:
  passed. New tests cover database reopen, schema-58 upgrade preserving pane
  settings, unversioned-current-schema adoption, normalized host/port/IPv6 and
  fingerprint validation, strict bounded request decoding, profile/account
  isolation, authorization, cross-origin refusal, read-only probes, concurrent
  compare-and-save conflicts and shared-workspace legacy restrictions. Existing
  proxy and kept-session certificate pinning regression tests also pass.
- `go test -race ./internal/store ./internal/httpapi`: passed.
- Final browser command: `go test -race ./internal/httpapi
  -run '^TestRememberedRDPCertificateTrustInBrowsers$' -v -count=1`, with
  `TESSERA_PLAYWRIGHT=$TMP/tessera-browser-cUa7BM/node_modules/playwright/index.mjs`
  and `PLAYWRIGHT_BROWSERS_PATH=$TMP/tessera-browser-cUa7BM/browsers`: passed in
  Chromium 158.0.8127.18 and WebKit 27.2, without race findings. Log:
  `$TMP/task263-browser-final.txt`.
  - Real embedded app, production API/database, controlled X.224/TLS probes and
    actual TLS certificate rotation on the same host/port; no RDP password/login
    or remote graphics session is sent by this test.
  - Initial refusal saves no approval. Explicit acceptance survives reload,
    another RDP window, an independent browser context and another workspace.
    Rotation warns and focuses Cancel, with no password field yet. Declining
    keeps the old pin; explicit reapproval updates account trust; an older pane
    subsequently uses that new approval without re-prompting.
  - Initial fixture runs caught globally duplicated pane IDs and an ambiguous
    address/status-field selector, both fixed in the harness. Desktop WebKit
    reports two workspace-fetch access-control diagnostics during deliberate
    document navigation, despite the existing unload-save rejection handler.
    These exact workspace-only/navigation-only diagnostics are recorded
    separately (Chromium: 0, WebKit: 2), not represented as certificate failures
    or a claim of zero browser diagnostics. Other page errors still fail the test.
- `npm run build:web`, `go vet ./...` and
  `go build -o $TMP/tessera-rdp-trust-N6F3Dq/tessera ./cmd/tessera`: passed.
  Go/gofmt used `$TMP/tessera-go-1ovo0srj/go/bin` (on PATH for the web build).
- `node scripts/frontend-smoke.mjs
  --binary=$TMP/tessera-rdp-trust-N6F3Dq/tessera
  --playwright=$TMP/tessera-browser-cUa7BM/node_modules/playwright/index.mjs
  --output=$TMP/tessera-rdp-trust-N6F3Dq/frontend` with the same browser path:
  passed, no uncaught browser errors. Covers embedded startup, Settings/fonts,
  autosave/conflict/reload, pane activation, Browser, phone input modes and native
  lifecycle commands. Run before final conservative system-sign-in legacy rule;
  that rule is covered by the final Go tests and rebuilt binary.
- `git diff --check`: passed after task finalization.
- `$TMP` is
  `/private/var/folders/3w/cdclg6hj6n7fvmrmtkt1m7lw0000gn/T/opencode`.
- Pending manual acceptance: actual RDP logins/graphics in kept/in-page modes,
  certificate rotation where a trusted test host permits it, and physical iPad
  Safari/native use. Added section 5 of `docs/performance-acceptance.md`; fixture
  browser results do not claim these device/live-RDP checks.

## Implementation notes

- Existing trust is held in `rdpTrustedTarget`/`rdpTrustedFingerprint` on each pane,
  serialized by `web/workspace-document.mjs` and `internal/store/workspace.go`.
  `web/rdp-session.mjs` schedules a workspace save immediately after acceptance.
  This does not provide target-wide reuse in a new RDP window.
- Existing backend proxy/kept paths require a fingerprint and reject a different
  certificate on the actual connection; preserve those checks.
- Added migration 059 and `internal/store/rdp_trust.go`: one SHA-256 fingerprint
  per user/normalized target, independent of pane deletion or workspace/settings
  revision saves. Database checks require 64 lowercase hex digits. Transactional
  comparison with the previously read pin rejects stale different approvals;
  concurrent same-certificate approvals remain idempotent.
- `internal/httpapi/rdp_trust.go` and the registered `/api/rdp-proxy/trust` POST
  accept explicit approvals only, derive the user from authorized server context,
  and reject supplied passwords/unknown fields. Certificate probes return the
  account's stored pin and legacy-pane policy without changing either.
- With sign-in enabled the actual signed-in account owns trust, including when
  system sign-in shares a workspace. With sign-in off, use the selected workspace
  profile/default. Matching legacy pins can be promoted for compatible no-sign-in
  profiles or owner-isolated file accounts. System sign-in cannot establish who
  approved an old pane pin, so it conservatively requests approval once more.
  No broad migration silently imports potentially conflicting legacy approvals.
- `web/rdp-session.mjs` prefers current account trust over stale pane settings,
  awaits a successful trust write before asking for credentials, retains pane
  fields for backwards compatibility and guards workspace/profile/account/pane
  changes. Older server responses retain their per-pane flow. Updated dialog
  wording explains persistence; connection-time certificate validation is unchanged.
- A deliberate certificate approval remains valid if credentials are subsequently
  cancelled or login fails: only a probe/failure/cancellation alone cannot learn
  trust. No password is added to any persistence path.
- Updated changelog, RDP product docs and combined manual checklist. The new
  server build migrates the database on startup; back it up before upgrading,
  and reload web/native clients. No Swift rebuild is required for this feature.
- No active server restart, commit, push or changes to unrelated task work.
