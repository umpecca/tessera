# Task 264: Native macOS host manager

Status: proposed (2026-11-12). Draft only; implementation not approved.

## Request

Provide a native macOS `.app` wrapper bundling the existing Go Tessera server,
with configuration of its CLI options, Tessera user administration, updates,
and creation/administration of its local HTTPS certificates. Do not require
Developer ID signing, notarization, a paid Apple account or App Store distribution.

## Scope

- Build a SwiftUI/AppKit host-management application containing the existing Go
  executable and embedded web assets. Open the workspace in the default browser;
  an embedded workspace is not part of this first version.
- Provide native Server, Configuration, Users, Certificates and Updates sections.
  Manage start/stop/restart, readiness, errors and bounded/redacted server logs.
  Disable the child's existing tray to avoid duplicate native controls. Closing
  the window may leave the manager in the menu bar; explicit Quit stops its child
  cleanly, with a warning about active sessions. Prevent duplicate managed servers
  and report port conflicts without stopping an unrelated Tessera installation.
- Expose all supported macOS server configuration flags with typed controls,
  repeatable lists, defaults, validation, persistence and restart notices. Preserve
  the difference between an omitted flag and an explicit value, especially `-auth`.
  Inventory flags against the Go entry point and add regression coverage against
  drift. Explain wrapper-managed options such as `-tray`; mark deprecated/no-op
  flags as such and exclude platform-inapplicable/internal helper invocations
  such as `-systemd-update` rather than presenting them as working settings.
- Reuse existing account commands/APIs and validation for account listing,
  creation/removal, password changes, admin roles and sign-in modes. Keep the
  legacy `-users` workspace roster distinct from authenticated accounts and reject
  incompatible combinations. Support initial admin creation/local recovery without
  putting passwords or recovery tokens in arguments, preferences or logs.
- Reuse Tessera's existing local CA and certificate storage/renewal. Configure
  HTTPS listeners and DNS/IP names; show certificate expiry and CA fingerprint;
  export the public CA/enrollment profile. Provide explicit CA rotation with a
  warning that clients must trust the replacement. Do not silently replace a CA,
  export private keys by default, or bypass TLS validation. Any macOS trust-store
  change needs separate informed approval using supported system mechanisms.
- Store configuration, logs and the SQLite database outside the app bundle, using
  per-user macOS locations and restrictive permissions. Preserve custom database
  paths and existing accounts, workspaces and PKI; do not silently switch databases
  or migrate an existing installation. Run as the current user, not root.
- Update the whole app, including its matching Go server, rather than letting the
  existing binary updater overwrite the bundled executable. Route managed-mode
  update actions consistently, including those initiated in the web workspace;
  preserve standalone CLI update behavior. Verify artifact authenticity and
  version/architecture compatibility before installation, stage replacement,
  restart/health-check, and recover from failed replacement/startup. Account for
  database migrations when designing recovery; binary rollback alone is not a
  database rollback. Updates require explicit user action and preserve user data.
- Provide a reproducible no-Apple-credentials build/package path and an installable
  app archive. Local ad-hoc signing is permitted where required by macOS; it is not
  Developer ID signing or notarization. Document Gatekeeper approval, filesystem
  permissions and writable-install-location requirements without automatically
  removing quarantine or disabling system protections. Extend the existing
  tag-only release workflow without changing its triggers.
- Initial target: Apple Silicon macOS, matching the current Go release target;
  provisionally macOS 15+ to match the existing Apple app. Keep the existing iPad/
  Mac thin client working and distinguish the host manager's product/bundle identity.
- Update relevant product/build documentation and `CHANGELOG.md` during implementation.
- Out of scope: Intel/universal builds, App Store/sandbox distribution, remote
  host administration, OS-account creation/isolation, privileged daemons, launch at
  login, and restoration of the retired desktop preview. Do not resume task 247.
- Approval: user requested this draft and explicitly said Apple app signing is
  not of interest. Approval of the implementation scope above is pending.

## Acceptance criteria

- [ ] A packaged native app launches the bundled server without an external Go
  installation, reports readiness/failure, opens the browser workspace and stops
  its owned child cleanly. Duplicate launches and conflicting listeners are safe.
- [ ] Supported macOS server options are configurable and survive relaunch; flag
  omissions, repeatable values, invalid combinations and restart needs are handled.
- [ ] Native user/sign-in administration works against the selected database,
  including first-admin setup and password changes, with existing safeguards intact.
- [ ] Native HTTPS setup, certificate inspection/public export and explicit CA
  rotation work; normal restarts/updates preserve the CA and private material.
- [ ] Explicit whole-app updates verify artifacts, coordinate all managed update
  entry points, preserve data and demonstrate failure recovery. Standalone CLI
  updates still work; the bundled executable cannot independently self-replace.
- [ ] Building, installing and updating need no Apple developer credentials or
  notarization. Any ad-hoc signing and manual Gatekeeper steps are documented.
- [ ] Relevant automated checks and macOS app acceptance pass; remaining physical
  device/trust-store checks are explicitly recorded, not represented as performed.

## Verification

Intended checks; none performed yet beyond read-only repository investigation.

- Swift model/process/configuration tests: argument fidelity, validation, lifecycle,
  persistence, secret redaction, update verification/recovery and stale operations.
- Affected Go package tests for any administration, IPC or updater changes;
  broader `go test ./...` and `go vet ./...` as appropriate. Affected web modules:
  `node --test` with their test files; `npm run build:web` if web assets change.
- Native build/package without Apple credentials; inspect the bundled executable,
  architecture, metadata and any ad-hoc signature. Smoke-test a copied/moved app.
- Isolated macOS app acceptance using disposable databases: start/stop/restart,
  configuration reload, real account changes, HTTPS enrollment/renewal/CA rotation,
  occupied ports, duplicate launch, crash/startup errors and retained data.
- Controlled update acceptance: successful replacement/relaunch, tampered or wrong-
  architecture artifacts, interrupted downloads, unwritable installs and failed
  startup. Check data/database compatibility and unaffected standalone CLI behavior.
- Separately record downloaded-app Gatekeeper behavior and consented certificate
  trust on macOS/another device. Never alter the user's live server or trust store
  merely to complete tests. Run `git diff --check` before finalizing implementation.

## Implementation notes

- Existing foundations: `cmd/tessera`, `internal/desktop`, account commands/APIs,
  `internal/localhttps`, `internal/update`, and `apple/` SwiftUI code. Accounts and
  CA private material already live in SQLite; do not introduce parallel stores.
- Task 184 retired a desktop preview; this is a new local administration wrapper,
  not permission to restore its removed behavior. Task 196's Apple app remains
  a thin client and should not silently become a host on iPad or existing profiles.
- Before implementation, settle the local authenticated administration transport,
  minimum macOS version/product identity, and no-Apple-signing updater design.
  Independent update signatures with a pinned public key are a candidate; HTTPS
  plus an untrusted checksum alone is not an authenticity design. Do not weaken
  existing HTTP authentication or expose a new unauthenticated network admin API.
- No implementation, release publication, commit or push authorized by this draft.
