# Task 273: Streamline iPad trust for Tessera Local HTTPS

Status: implemented (2026-11-14); physical-iPad acceptance pending, and expiry/hostname rejection lacks dedicated tests.

## Request

Make self-signed Tessera Local HTTPS work more smoothly in the iPadOS app.
Two parts:

1. **Trust the Tessera root CA inside the app.** Today the app pins the leaf
   certificate's SHA-256 per server profile
   (`apple/Tessera/IPadServerConnection.swift`, `ServerCertificatePin`). The
   Local HTTPS leaf is valid for one month and renews within 7 days of expiry or
   when its names change (`internal/localhttps/localhttps.go`), so the app
   shows "Certificate Changed" roughly every three weeks. The leaf fingerprint
   also doesn't match the root CA fingerprint that Tessera's Local HTTPS dialog
   and enrollment page display, so the user has nothing to verify it against.
2. **Guide system-wide trust for Safari and other apps.** iPadOS doesn't let
   apps install or trust a root CA programmatically, but the app can hand the
   CA to the system profile installer and walk the user through the remaining
   manual steps.

## Scope

### Part 1: Tessera CA anchor per server profile

- Server: include the root CA in the Local HTTPS TLS chain (leaf + root) so
  clients can read it from the handshake. Keep `/api/host/https/ca` as is.
- App: when a server's certificate fails system validation and the presented
  chain contains a CA certificate that signed the leaf, the review alert offers
  to trust that **Tessera CA**. It shows the CA's subject and SHA-256
  fingerprint, which matches the value in the Local HTTPS dialog. If the chain
  has no root (an older server), the app keeps the existing server-certificate
  approval; updating the server enables CA trust. (Changed on 2026-11-14 from an
  `/api/host/https/ca` fetch fallback, which would need a second, specially
  pinned session just to cover a version mismatch.)
- Store the accepted CA per profile (certificate DER plus host/port scope),
  alongside or in place of the leaf pin, in `ServerProfiles`/`ServerCertificatePin`.
  Saved leaf pins keep working until replaced.
- Validation with a saved CA: build a fresh `SecTrust` with the SSL policy for
  the profile's host, call `SecTrustSetAnchorCertificates([ca])` and
  `SecTrustSetAnchorCertificatesOnly(true)`, and require
  `SecTrustEvaluateWithError` to succeed. Leaf renewals and name changes signed
  by the same CA pass silently. Expiry, hostname mismatch, or a different CA
  fail and re-prompt ("Certificate Authority Changed"). Declining never falls
  back to HTTP.
- Apply to both the `URLSession` preflight (`IPadConnectionAttempt`) and the
  `WKWebView` challenge handler (`TesseraWebView.swift`). Keep the current
  same-origin limit and the rule that a framework's cached exception must not
  approve other profiles or ports.
- Edit sheet: "Forget Accepted Certificate" also clears a saved CA. Update the
  help text in `IPadRootView.swift`.
- A non-Tessera self-signed server (a leaf with no CA in its chain) keeps the
  existing leaf-pin flow.

### Part 2: "Trust in Safari & Other Apps" helper

- Server: add a public enrollment endpoint that serves the root as an unsigned
  `.mobileconfig` (`com.apple.security.root` payload, display name
  "Tessera <host> Root CA", stable payload identifier/UUID derived from the CA),
  served as `application/x-apple-aspen-config`. Link it from the
  `/local-https/` enrollment page and the Local HTTPS dialog next to the `.crt`.
  Add it to `publicPath`.
- App: in the server edit sheet, add **Trust in Safari & Other Apps…**
  (pushed screen; not added to the certificate review alert, which stays a
  two-button decision). It opens a screen that:
  - shows the CA fingerprint and step-by-step instructions (open the profile,
    then Settings → General → VPN & Device Management → Install, then
    General → About → Certificate Trust Settings → enable full trust);
  - opens the profile in Safari. *Decided:* the app builds the profile from
    the CA this profile already trusts and serves it from a short-lived
    loopback listener (`127.0.0.1`, random port and path, 120 s, background
    task), opened with `x-safari-http://…` and falling back to the default
    browser. This needs no HTTP enrollment listener, no extra server request,
    and serves exactly the CA the user approved. No Files fallback was added;
  - re-checks system trust for the server when the app becomes active and shows
    "iPadOS trusts this server" or "Not trusted yet: full trust may not be
    enabled".
- No deep links to private Settings URLs (`App-prefs:`), no MDM, no background
  installation. The app still never changes system trust itself.
- Docs: update `docs/remote-access.md` (Local HTTPS for iPadOS),
  `apple/README.md` and `CHANGELOG.md`.

### Out of scope

- Signing the configuration profile.
- macOS app changes, beyond leaving any shared TesseraCore code working there.
- Changing CA or leaf lifetimes.

- Approval: the user approved Part 1 on 2026-11-14 ("go ahead with part 1
  first") and Part 2 on 2026-11-14 ("go ahead with part 2").

## Acceptance criteria

Part 1:

- [x] The Local HTTPS server presents leaf + root in its TLS chain; Go tests cover it.
- [x] The review alert for a Tessera server shows the root CA's name and
      fingerprint and offers **Trust Certificate Authority** for this profile.
      (Simulator UI test checks the CA name. The fingerprint is SHA-256 of the
      same root DER that the Local HTTPS dialog hashes; not compared against a
      live server yet.)
- [x] With a trusted CA saved, a renewed leaf (new key/serial, same CA) connects
      in both the preflight and the web view without a prompt (simulator).
- [ ] A leaf from a different CA, an expired leaf, or a hostname mismatch is
      rejected and re-prompts. Cancelling never falls back to HTTP.
      *Partial:* the different-CA case and cancelling are UI-tested. Expiry and
      hostname rely on `SecPolicyCreateSSL(true, host)` evaluation and have no
      dedicated fixture.
- [x] The saved CA applies only to its profile's host/port (unit-tested via
      `applies(to:)`, checked before anchored evaluation).
- [x] Older servers without a root in the chain keep the server-certificate
      approval; the existing self-signed-leaf UI tests still pass. Existing leaf
      pins decode unchanged (`authority` is optional). Forget clears both (same field).
- [x] Docs and CHANGELOG updated for Part 1.

Part 2:

- [x] `.mobileconfig` endpoint serves a valid root payload without sign-in;
      enrollment page and Local HTTPS dialog link it. (`/local-https/tessera-local-ca.mobileconfig`
      and `/api/host/https/ca.mobileconfig`; Go tests check XML, payload,
      content type, signed-out access and links.)
- [x] The app's "Trust in Safari & Other Apps" screen hands the profile to
      Safari, shows the steps and fingerprint, and reports system trust (on
      open and when the app becomes active). Simulator: Safari opened and showed
      its configuration-profile download prompt; status read "Not trusted yet".
      Installing the profile and enabling full trust is not automated.
- [x] Docs and CHANGELOG updated for Part 2.

## Verification

- Go: `go test ./internal/localhttps/... ./internal/httpapi/...` (chain contents,
  mobileconfig body/content type/public access); `go vet ./...`.
- Web: `node --test web/local-https-dialog*.test.mjs` if the dialog changes.
- Swift: TesseraCore unit tests for CA pin encoding/scoping and migration of
  existing leaf pins (`swift test` in `apple/TesseraCore`).
- UI tests with new fixtures: a CA-signed loopback leaf, a second leaf from the
  same CA (renewal) and a leaf from another CA, alongside the existing
  `loopback-a/b.p12`.
- Manual on a physical iPad (record results separately from automated tests):
  approve CA, force leaf renewal on the host and reconnect with no prompt;
  install the profile through the helper, enable full trust, confirm Safari
  opens `https://host:7332` and the app shows the trusted state.

### Part 1 results (2026-11-14)

- `go test ./internal/localhttps/ ./internal/server/ ./internal/httpapi/`: passed,
  including new `TestEnsureServesRootAfterLeafInTLSChain` (real TLS handshake;
  leaf verifies against the presented root for `tessera.local`).
- `go vet ./internal/localhttps/`, `gofmt -l`, `git diff --check`: clean.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
  --package-path apple/TesseraCore`: 35 tests in 6 suites passed, including new
  `authorityPinsMatchTheirCertificateAndNeverAcceptALeafFingerprint`. Plain
  `swift test` with Command Line Tools can't load the Swift Testing macros.
- iPad Release build, unsigned (`xcodebuild -scheme Tessera-iPad -destination
  'generic/platform=iOS' -configuration Release CODE_SIGNING_ALLOWED=NO`):
  succeeded with no warnings.
- Native UI tests in a disposable simulator (`node scripts/apple-ipad-tests.mjs
  --only=…`): `testTrustedCertificateAuthorityCoversRenewalsButNotAnotherAuthority`
  (new) and `testAcceptedCertificatePersistsChangesRequireApprovalAndTrustCanBeForgotten`
  passed, 2/2.
- Not done: physical iPad against a real Local HTTPS server (approve the CA,
  force a renewal by adding a DNS name in Local HTTPS settings, reconnect with
  no prompt).

### Part 2 results (2026-11-14)

- `go vet ./...` and `go test ./...`: passed. New
  `TestRootProfileCarriesTheRootWithFingerprintIdentifiers`; mobileconfig
  checks added to the Local HTTPS API test and `TestSignedOutRequests`.
- `node --test web/*.test.mjs`: 1064/1064 passed. `npm run build:web`: no
  changes to committed generated files.
- `swift test` (Xcode `DEVELOPER_DIR`): 36 tests in 6 suites passed, including
  `rootProfileMatchesTheServersIdentifiersAndCarriesTheAuthority`. It checks the
  same identifiers as the Go test, so a profile installed from Safari enrollment
  and one from the app replace each other.
- iPad Release build, unsigned: succeeded with no warnings.
- Native UI tests (disposable simulator): new
  `testSystemTrustScreenHandsTheTrustedAuthorityToSafari` plus both certificate
  tests: 3/3 passed. Safari's dialog was dismissed with Ignore; nothing was installed.
  After a later retain-cycle fix in the handoff listener, the handoff test was
  rerun on its own: 1/1 passed.
- Full native UI suite on the Part 2 code (before that one-line fix): 13/14
  passed, 0 failed; `testBareHostUsesDefaultHTTPWhenHTTPSIsUnreachable` skipped
  because a real HTTPS listener owns port 7332 (same environment skip as task
  267). The Part 1 full run was 12/13 with the same skip.
- Mac app unsigned build (`-scheme Tessera -destination 'platform=macOS'`):
  succeeded with no warnings.
- Not done (physical iPad): download through the helper, install, enable full
  trust, confirm Safari opens `https://host:7332` and the screen shows
  "iPadOS trusts this server". Also confirm `x-safari-` opens Safari when
  another browser is the default.

## Implementation notes

- 2026-11-14: physical-iPad acceptance was blocked by task 274. ATS rejected
  the approved CA in the native connection check for any non-local address
  (`-1200 [3:-9802]`); loopback UI tests could not see it. Retry after 274.

- Profile identifiers: `org.tessera.local-https.<first 8 bytes of SHA-256 hex>`;
  payload UUIDs from the first and second 16 digest bytes (version-8 UUIDs).
  Implemented in Go (`ProfileIdentifiers`) and Swift
  (`RootCertificateProfile.identifiers`), pinned by matching golden tests.
- `ServerCertificatePin.formatted` (uppercase, colon-separated) is now used by
  the certificate alert too, so fingerprints read like the Local HTTPS dialog.

- Before this change the server chain held only the leaf (`loadServerPair`
  reads `server.crt`, which is just the leaf PEM). `Ensure` now appends the root
  DER to the served chain; stored files are unchanged.
- `ServerCertificatePin` gained optional `authority` (CA DER). `sha256` is then
  the CA fingerprint. `applies(to:)` rejects a decoded pin whose authority no
  longer hashes to `sha256`; `accepts(url:sha256:)` is leaf-only.
- `IPadCertificateConsent.answer`: a saved authority is evaluated anchor-only
  against the presented chain. Otherwise, after system trust fails, any
  non-leaf certificate in the chain that anchors it (root first) is offered as
  the authority; if none, the existing leaf prompt is shown. The web view uses
  the same function, so both paths get this.
- New fixtures `loopback-ca-{a1,a2,b1}.p12` from
  `scripts/generate-ipad-ca-fixtures.sh` (leaves expire 2029-02-11, the iPadOS
  825-day limit). `FixtureHTTPServer` can now serve issuers via
  `sec_identity_create_with_certificates`.
- `SecTrustSetAnchorCertificatesOnly(true)` stops a system-trusted but unrelated
  CA from satisfying a profile that has a saved Tessera CA.
