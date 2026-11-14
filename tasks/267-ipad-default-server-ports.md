# Task 267: Prefer default HTTPS when connecting from iPad

Status: implemented; default-HTTP simulator and physical-device acceptance pending (2026-11-12).

## Request

Let the native iPad app connect using Tessera's default HTTP/HTTPS ports unless a port is specified, preferring HTTPS when available.

## Scope

- For a newly entered bare hostname/IP without a port, try HTTPS on 7332 first; use HTTP on 7331 only when HTTPS is not available.
- For explicitly entered `https://host` or `http://host` without a port, default to 7332 or 7331 respectively. An explicit scheme fixes the transport; an explicit port is never replaced. Preserve the existing bare `host:port` HTTP interpretation; enter `https://host:port` to specify custom HTTPS.
- Discover the endpoint before saving/connecting the profile, using bounded, cancellable, credential-free checks. Do not silently follow redirects to unrelated origins or send login data as part of discovery.
- On a certificate/trust failure, show an explicit native certificate decision: hostname/port, validation problem and SHA-256 certificate fingerprint, with Accept Certificate and Cancel. Never accept silently or downgrade to HTTP because a certificate was rejected.
- Persist the SHA-256 fingerprint of an explicitly accepted certificate on the iPad, scoped to the saved server profile and its exact hostname/port. Reuse that approval across launches only for the same certificate; a changed certificate requires a new decision. This is a certificate fingerprint/pin, not a saved password or a system-wide CA trust change.
- Provide a way to forget a saved certificate approval in the server-profile UI. Editing a profile to a different origin must not carry over the old approval. Do not overwrite an existing pin on cancellation, failure or a stale asynchronous response.
- Use public URLSession/WebKit authentication-challenge APIs, never private APIs or blanket trust bypasses, and do not extend an exception to unrelated origins or embedded browser content.
- Explicit HTTPS must never automatically fall back to HTTP. Without a user-approved exception, normal platform certificate validation remains in force.
- Preserve URL paths/queries, server-profile origin isolation, and existing saved profile URLs/sign-ins. Do not rewrite existing profiles or change Mac URL defaults.
- Update the server-address form's hints/help and `apple/README.md`, add regression coverage and a changelog entry.
- User refinement: certificate errors should offer an explicit accept-or-decline choice (2026-11-12).
- User refinement: remember accepted certificate fingerprints so a matching certificate does not warn again on future launches (2026-11-12); supersedes the earlier current-run-only proposal.
- Approval: user explicitly directed implementation (“ok lets do the task”), including persistent per-profile/server certificate pins and a forget-approval control (2026-11-12).

## Acceptance criteria

- [ ] A bare server name prefers `https://host:7332` and connects to `http://host:7331` when HTTPS is unavailable. HTTPS preference is simulator-verified and fallback policy is unit-tested; the HTTP-only native case is blocked by the existing HTTPS listener and remains pending.
- [x] Explicit schemes and custom ports are honored; scheme-specific default ports apply only to new iPad address input.
- [x] Certificate errors offer an informed accept-or-cancel choice; declining never downgrades to HTTP. Explicit approvals persist across launches for only the exact saved server/certificate, certificate changes require reapproval, and users can forget an approval. Discovery sends no saved credentials/cookies.
- [x] Failed/cancelled/stale checks cannot save or connect the wrong server; saved-profile isolation and Mac parsing behavior remain intact.
- [x] Relevant automated tests/builds pass (one environment-blocked native test skipped), documentation is updated, and simulator versus physical-device checks are recorded separately.

## Verification

- Intended: Swift package address/candidate/discovery and certificate-pin scope/persistence/reset regressions; native iPad simulator tests using generated endpoints/certificates for accept, cancel, relaunch, changed certificates and forgetting trust; shared Mac and iPad build checks; and `git diff --check`.
- Distinguish mocked discovery, real simulator network checks and physical iPad DNS/certificate/local-network acceptance. Do not claim certificate trust on a real device without testing it.
- Final `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path apple/TesseraCore`: **34/34 passed**, six suites.
- Final complete native run: **11 passed, 0 failed, 1 skipped**, result `…/T/opencode/tessera-ipad-ui-Zzfwt7/Results.xcresult`. Command: `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node scripts/apple-ipad-tests.mjs --output=…/T/opencode --derived-data=…/T/opencode/tessera-267-ipad`. Includes all prior native regressions, default-port HTTPS preference/decline, persistent certificate rotation/forget/cookies/iframe isolation, and cancellation. The HTTP-only default-port case explicitly skips because 7332 already has a reachable HTTPS listener; it does not stop that server or claim fallback was observed.
- Latest unsigned Mac build (`Tessera`, `platform=macOS,arch=arm64`, derived data `…/T/opencode/tessera-267-mac`) and unsigned iPad device Release build (`Tessera-iPad`, `generic/platform=iOS`, derived data `…/T/opencode/tessera-267-release`): **passed**. No `.p12` fixtures are present in the Release app bundle.
- `git diff --check`: passed. No commit/push, app installation, system trust modification, IPA packaging or unrelated task implementation was performed.

## Implementation notes

- Existing `ServerAddress.parse` defaults bare hosts to HTTP 7331 but leaves full URLs without a port on web-standard 80/443. It is shared by Mac UI and persisted-profile validation, so new iPad input behavior must not rewrite stored origins or change the Mac defaults.
- Current iPad server form saves the parsed URL synchronously in `ServerProfilesView.save()` in `apple/Tessera/IPadRootView.swift`.
- Tessera's default Local HTTPS port is 7332; a server configured with different ports still requires those ports explicitly.
- Implementation begins after approval. Preserve previous tasks' uncommitted changes and unrelated files.
- Added iPad-only input candidate parsing (`IPadServerAddress`) without changing `ServerAddress.parse`. New profiles use HTTPS/7332 first; explicit URLs use scheme-specific Tessera defaults, while stored 80/443 URLs remain unchanged.
- Added an optional per-profile `ServerCertificatePin`, persisted with existing profile data. It matches an exact HTTPS hostname/port and SHA-256 leaf-certificate fingerprint, survives relaunch, and does not transfer to an edited origin. The profile editor exposes Forget Accepted Certificate.
- Discovery uses ephemeral, cookie/credential/cache-free HEAD requests to `/api/health`, stripping entered query/fragment and following no redirects. HTTP fallback is limited to connectivity/unavailability errors; seeing a TLS/certificate challenge blocks automatic downgrade.
- Certificate decisions are native, scene-local and cancellable on profile changes, form dismissal, app inactivity/privacy lock and operation cancellation. New pins are provisional until endpoint verification succeeds. Saved HTTPS profiles also get a fresh preflight before a load/reload so WebKit's existing TLS cache cannot bypass forgetting a pin or detecting rotation.
- Important API boundary: TLS trust is origin-level, not path-level. WebKit's authentication challenge does not identify a frame. New consent prompts are limited to selected-server top-level entry/app/login navigation; matching pins apply only to the selected server origin. Other iframe origins/ports use normal platform trust. Same-origin proxy bytes necessarily share the Tessera listener's certificate; this does not approve the remote/proxied site's certificate or grant native clipboard privileges to its frame.
- Initial Swift package tests: 34/34 passed (six suites, including five new address/fallback/persistence policies). Shared Mac unsigned build passed.
- Initial native simulator run: background-cancellation regression passed. Other tests exposed a real review-timeout issue and fixture problems: network deadlines were dismissing human certificate review, and failed TLS handshakes were incorrectly recorded as application requests. Review now occurs after ending the failed probe, followed by a fresh pinned connection; the fixture ignores empty receives. A clean HTTP-only fallback still needs rerun/diagnosis. No failing test is treated as acceptance.
- Trust-chain validation now runs off the UI thread using a fresh platform trust object, not a framework's cached exception. Tests exercise a ten-second human review period, matching-certificate relaunch, rotation/cancel/reapproval, origin isolation and forgetting trust.
- Added generated loopback-only PKCS#12 identities to the UI-test target, not the production app; no production credentials were used and no system trust stores were modified.
- Subsequent native runs verified HTTPS preference, explicit accept/cancel without downgrade, a ten-second review with no network deadline, background cancellation and rejection of an iframe on another port even with the identical leaf certificate. Relaunch verification exposed a fixture using a session-only cookie; it now uses Max-Age so persistence assertions reflect remembered sign-ins.
- `lsof -nP -iTCP:7331 -iTCP:7332 -sTCP:LISTEN` confirmed an existing `tessera-d` process owns the default ports. It was not stopped or reconfigured. Fixed fixture binding to pass the requested port explicitly and verify the listener actually reached `.ready`; default-port-only tests skip rather than assume a failed bind succeeded. Discovery requests carry no personal credentials, and test apps use isolated preferences/website stores. A full native suite rerun is pending.
- Added explicit active-state propagation to the WebKit wrapper so an initial HTTPS preflight interrupted by scene activation can restart, while healthy foreground resumes do not reload the page. Fresh-probe callback identity guards reject late authentication responses from retired sessions.
- iPad unsigned Release build passed before the final callback/fixture refinements; repeat before finishing. Physical DNS/local-network permission, real certificate rotation and terminal/WebSocket use remain distinct acceptance checks.
- Latest Swift package rerun: 34/34 passed. Latest shared Mac build and iPad device Release build both passed with the updated trust/cancellation code. Verified the Release app bundle contains no `.p12` test identities.
- Full native regression run `…/T/opencode/tessera-ipad-ui-9CMPqC/Results.xcresult`: all eight prior native regressions and the new background-cancellation regression passed. One new rotation fixture failed because Network.framework rejects specifying a fixed port in both parameters and the listener initializer; two default-port cases were skipped by the overly broad fixture error handler. Corrected the fixture to specify the port only once, verify the actual bound port, and skip only genuine EADDRINUSE errors. These skips are not counted as validated default-port behavior; the four new tests are rerunning.
- Targeted native rerun `…/T/opencode/tessera-ipad-ui-NvYSEe/Results.xcresult`: **three new tests passed**, covering real default-port HTTPS preference/decline without downgrade/ten-second review, background cancellation, and the complete persisted-pin/relaunch/rotation/decline/reapproval/forget sequence with cookie preservation and cross-port iframe isolation. The remaining HTTP-only case encountered the existing wildcard HTTPS listener once its temporary port-availability fixture was stopped. Added a credential-free TCP reachability check before claiming 7332 so that case skips when HTTPS genuinely exists, without stopping the person's server. Final complete native rerun pending.
- Added a regression preserving an unchanged older saved `https://host/` or `http://host/` URL (implicit 443/80) when renaming/saving its profile. New text still uses the new Tessera defaults; explicitly replacing an old HTTP address with a bare hostname can request HTTPS discovery. Swift package rerun: **34/34 passed**; latest Mac and iPad Release builds passed.
- Final builds and regression results are recorded above and supersede earlier pending reruns. The native run reports three main-thread runtime warnings around the TLS tests; production trust-chain extraction and validation run on a worker queue. The warnings have not been attributed or treated as physical-device performance evidence.

## Physical-device acceptance still required

- [ ] Verify default HTTPS/HTTP selection with the target server's actual DNS and local-network permission, including an HTTP-only server on the default ports when available.
- [ ] Verify accepted fingerprint persistence, certificate rotation/cancel/reapproval and forgetting trust on a physical iPad.
- [ ] Verify real sign-in, persistent cookies and terminal/WebSocket reconnection over explicitly accepted HTTPS, plus VoiceOver review of the native certificate dialog.
