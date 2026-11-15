# Task 274: iPad connection check blocked by App Transport Security

Status: implemented (2026-11-14); physical-iPad acceptance pending.

## Request

The user connected the iPad app to `https://remotemacserve.gofffamily.org:7332`
(their own instance, Local HTTPS) and tapped **Trust Certificate Authority**. The
app then showed "Could not reach https://…:7332: A TLS error caused the secure
connection to fail." The server logged `http: TLS handshake error from
100.96.87.110:…: EOF`. Fix it so that in-app certificate approval works for real
servers.

## Investigation (2026-11-14, before any repo change)

Reproduced in a disposable iPad simulator against the user's running instance,
using a scratch copy of `apple/` with temporary UI tests. The repo was not
changed.

- Fails with the DNS name **and** with the Tailscale IP `100.120.3.59`.
- Simulator log for the connection check (`IPadConnectionAttempt`, `URLSession`)
  after approval: `auth completion disp=0` (the app answers useCredential), then
  `System Trust Evaluation yielded status(-9802)`, `ATS failed system trust`,
  `HTTP load failed … -1200 [3:-9802]`.
- Root cause: App Transport Security re-evaluates the returned trust against
  **system** roots only. `NSAllowsLocalNetworking` exempts loopback and `.local`
  names, so the UI tests on `127.0.0.1` never saw it. Tailscale IPs and DNS
  names are covered by ATS.
- Setting the approved CA as the anchor on the challenge's own trust object
  (`SecTrustSetAnchorCertificates` + `…Only`; the trust then evaluates true) still
  fails with the same `-9802`. ATS ignores custom anchors.
- Second bug, same cause: plain `http://remotemacserve.gofffamily.org:7331` fails
  the connection check with `-1022` ("App Transport Security has blocked a
  cleartext HTTP connection"). So HTTP to Tailscale MagicDNS names never worked
  either.
- The web view is unaffected (`NSAllowsArbitraryLoadsInWebContent`). The only
  other `URLSession` use is the "Trust in Safari" system-trust status check,
  which is meant to use system trust.
- Replacing the ATS keys with `NSAllowsArbitraryLoads` = true (no code change):
  HTTPS by DNS name, HTTPS by Tailscale IP and HTTP by DNS name all connect and
  load the live workspace (3/3, simulator).

## Scope

- `apple/Tessera-Info.plist`: replace `NSAllowsArbitraryLoadsInWebContent` and
  `NSAllowsLocalNetworking` with `NSAllowsArbitraryLoads` = true. Those keys must
  go: on iOS 10+ / macOS 10.12+ either one makes the system ignore
  `NSAllowsArbitraryLoads`. Add a comment: Tessera connects to servers the user
  enters, and certificate trust is enforced by the app's own consent and pin
  checks (`IPadCertificateConsent`), not by ATS. The plist is shared with the
  Mac app; its web view already had arbitrary loads, so no behavior change there.
- No change to the trust logic: without ATS in the way, the app's existing
  checks decide (system trust → default handling; otherwise
  prompt/pin/authority, never an HTTP fallback after a certificate).
- Regression check: a test that reads `Tessera-Info.plist` and fails if
  `NSAllowsArbitraryLoads` is missing or any key that disables it is present
  (TesseraCore `swift test` or a small node test, matching existing practice).
- Docs: `apple/README.md` plist line; `CHANGELOG.md` entry (iPad: certificate
  approval and HTTP by hostname now work for non-local addresses).
- Task 273: note that its physical-iPad acceptance was blocked by this bug.
- Out of scope: replacing the `URLSession` check with Network.framework (keeps
  ATS strict, but much more code); fixing the stale `192.168.0.139` SAN on the
  user's Local HTTPS certificate (the Mac's LAN IP is now `192.168.0.125`; that
  is a settings change on the server).
- Approval: the user approved this scope on 2026-11-14 ("yes").

## Acceptance criteria

- [x] After approving the Tessera CA, the iPad app connects to a Local HTTPS
      server by DNS name and by Tailscale IP. (Simulator against the user's
      live instance; physical iPad pending.)
- [x] `http://<dns-name>:7331` passes the connection check. (Simulator, live.)
- [x] Certificate review still appears for untrusted certificates; cancel never
      falls back to HTTP (existing UI tests pass).
- [x] The plist regression check fails on the old key set and passes on the new one.
- [x] README and CHANGELOG updated.

## Verification

- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test
  --package-path apple/TesseraCore --filter appTransportSecurity` on the old
  plist: failed with 2 issues (missing `NSAllowsArbitraryLoads`, extra keys), as
  intended. After the change, full `swift test`: 37 tests in 6 suites passed.
- `plutil -lint apple/Tessera-Info.plist`: OK.
- Native UI tests (disposable simulator, loopback fixtures):
  `testBareHostPrefersHTTPSAndCertificateCancellationNeverFallsBack`,
  `testAcceptedCertificatePersistsChangesRequireApprovalAndTrustCanBeForgotten`,
  `testTrustedCertificateAuthorityCoversRenewalsButNotAnotherAuthority`,
  `testSystemTrustScreenHandsTheTrustedAuthorityToSafari`,
  `testBackgroundCancelsCertificateReviewWithoutSavingAProfile`: 5/5 passed.
- Unsigned Release builds, `Tessera-iPad` (generic iOS) and `Tessera` (macOS):
  succeeded with no errors or warnings; both built Info.plists contain only
  `NSAllowsArbitraryLoads` under ATS.
- Live simulator check (temporary UI tests in the scratch copy only, against the
  user's instance on 7331/7332, using the repo's plist and connection code):
  `https://remotemacserve.gofffamily.org:7332`, `https://100.120.3.59:7332` and
  `http://remotemacserve.gofffamily.org:7331` all connected: 3/3, zero
  `-9802`/`-1200`/`-1022`/ATS log lines, every `/api/health` check finished
  successfully. Before the change the first two failed with `-1200 [3:-9802]`
  and the third with `-1022`.
- Not done: physical iPad (user rebuilds/sideloads, approves the CA, connects by
  DNS name).

## Implementation notes

- Changed: `apple/Tessera-Info.plist` (ATS keys plus comment),
  `apple/TesseraCore/Tests/TesseraCoreTests/IPadServerAddressTests.swift`
  (`appTransportSecurityLeavesServerTrustToTheApp` reads the plist via `#filePath`),
  `apple/README.md`, `CHANGELOG.md`, task 273 note.
- No trust-logic change. The `-9802` came from ATS, not from
  `IPadCertificateConsent`, so its approval and pin rules are unchanged.
- The temporary live tests stayed in the scratch copy (`ats-repro/`); they hit a
  real server and are not suitable for the repo suite.
