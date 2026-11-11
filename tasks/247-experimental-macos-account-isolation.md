# Task 247: Experimental macOS account isolation

Status: TBD / later (2026-11-09), deferred at the user's request. Not implemented;
retain this scope for future consideration, but do not start work until resumed.

## Request

Resume "sign in as yourself" as a macOS-only, opt-in experiment until other
test machines are available. A signed-in person's host operations run as
their operating-system account, not as the account running Tessera. Existing
installations keep their current behavior unless explicitly opted in.

Create this task first; implementation, privileged installation and live
account tests are separate work.

## Relationship to existing work

- Builds on [task 244](244-sign-in-as-yourself.md), including its completed
  macOS password-verification and cross-account PTY experiments. Do not repeat
  those experiments without a specific unanswered question.
- This task governs the initial rollout where task 244 proposes a broader
  Linux/macOS service deployment. Linux and Windows account isolation remain
  deferred; [task 245](245-test-platforms.md) is not a prerequisite for this
  macOS experiment.
- Preserve task 244's findings: the worker must report shell exit status,
  close its PTY master after passing it, and the server must make the received
  descriptor non-blocking. macOS supplementary-group handling still needs
  verification; copying an arbitrary group list fails above its 16-group limit.
- Remotr shares the Mac's one screen. This feature does not promise a private
  desktop for every account or automatic screen-server sign-in.

## Rollout decisions

1. **Default off, enabled only at startup:**

   ```sh
   tessera -auth=system -experimental-account-isolation
   ```

   The boolean flag defaults to false. Do not add a persisted setting or UI
   toggle in this task. Without the flag, `-auth=off`, `-auth=file`, and today's
   fixed-host-account `-auth=system` keep their existing meaning.
2. **macOS only.** Use platform-specific implementations and unsupported-platform
   stubs. Other systems reject an enabled flag with an actionable error, rather
   than ignoring it. Their existing builds and runtime paths stay supported.
3. **Explicit configuration.** Require `-auth=system`; reject incompatible modes.
   Initially reject `-users` in isolation mode rather than treating its roster
   as verified identities. No behavior changes to the roster when the flag is off.
4. **Explicit privileged setup.** Install the helper separately, with informed
   operator approval. Starting Tessera must not silently install a daemon,
   create an OS account/group, request elevation or change system permissions.
5. **Fail closed.** Missing, incompatible or unavailable helper support must
   refuse startup or the affected operation. Never fall back to executing as
   Tessera's account. Reject a root-run web server in this mode.
6. **No forced migration.** Do not rewrite existing workspace ownership, adopt
   legacy `-users` names as OS identities, or change existing service setup.
   Keep experimental state separate from legacy workspaces/sign-ins unless the
   operator explicitly chooses an adoption procedure designed and tested here.
7. **No CI/CD redesign.** Keep the existing tag-triggered release workflow.

## Architecture and security boundary

Use task 244's three-process model:

- **Web server:** unprivileged; owns HTTP, browser transport and application
  state. An HTTP-supplied username or workspace ID is never permission to
  select a worker.
- **Root helper:** a small, explicitly installed `launchd` service. Verifies
  account eligibility and passwords itself, issues scoped worker grants, and
  starts/stops workers. It is not a general root shell or file-operation API.
- **Account worker:** drops root privileges before accepting host operations;
  runs with the account's canonical UID, primary and supplementary groups,
  home, shell and a controlled environment. Never inherit the server's
  credentials, private environment or shell-integration cache as the user's.

Before implementation, record the protocol, trust assumptions and ownership
table: server, account, workspace, pane, sign-in and browser attachment. Define
who starts, retains and stops every process, PTY, descriptor, transfer and kept
session, including cancellation during startup and workspace deletion.

Required controls:

- Authenticate local IPC peers and validate socket/binary ownership and
  permissions. A user-writable executable or socket path cannot become a root
  execution path. Bound message sizes, descriptors, concurrent requests and
  operation lifetimes; reject malformed and incompatible protocol messages.
- The helper authenticates accounts, not arbitrary caller-chosen UIDs. Resolve
  canonical local identities; deny root, service/system accounts and accounts
  excluded by the access policy even when credentials are valid.
- Make eligibility explicit. Task 244 proposes a `tessera` group plus admins;
  finalize and document the rule before implementing admission. Do not silently
  allow every local account or use a numeric UID threshold as the only check.
- Bind helper grants, sign-ins and worker requests to the verified identity.
  Legacy remembered sign-ins and host recovery links must not authorize another
  account's worker. Define expiry, revocation, account removal/password changes,
  server/helper restart and recovery behavior before enabling this path.
- Passwords never enter process arguments, environment, logs, audit records or
  durable storage. Do not add task 244's optional screen-password retention or
  credential pass-through in this initial experiment.
- Preserve browser reconnect and retained-session behavior. Signing out revokes
  access; do not silently redefine whether existing work survives it. Document
  the worker lifetime and reauthentication needed to resume that work.

This is OS-account privilege separation, not a sandbox against a compromised
web server with access to active workers, nor a new network namespace. State
those limits explicitly rather than claiming stronger isolation.

## Host-operation coverage

Inventory every route and background operation before enabling the mode.
Each must execute through the correct worker, remain a narrowly authorized
server-management operation, or be explicitly unavailable in isolation mode.
There must be no remaining user-operation path using the server's identity.

- Terminals: directory validation/defaults, shell launch, environment, shell
  integration, PTY hand-off, resizing, exit status and forced termination.
- Shortcuts: directory checks, command expansion and process launch.
- Files: folder browsing, attachments, clipboard-to-file saves/deletion,
  uploads/downloads, temporary files, renames and terminal transfer validation.
- Clipboard and desktop integration: use only the target account's available
  GUI session. If none is available, explain the limitation or disable the
  operation; never read/write the server operator's clipboard instead.
- Browser proxy and RDP/VNC, including kept sessions: make account ownership
  and allowed access explicit. Worker execution alone does not make loopback
  development servers private. Define/enforce that policy or disable unsupported
  paths; do not accidentally retain a shared-server bypass.
- HTTPS, sign-in administration, helper management, self-update and restart:
  separate these server-wide privileges from ordinary account operations.

Do not label a terminal-only milestone as complete account isolation. While
coverage is incomplete, reject unsupported operations in experimental mode.

## Implementation plan

1. **Design and focused macOS checks.** Record ownership, IPC/grant protocol,
   admission policy, data separation and failure behavior. Verify macOS group
   initialization, privilege dropping and GUI-session limitations. Recover or
   rebuild the old spikes only where needed; their scratch paths are historical.
2. **Flag and dependency boundary.** Add CLI validation, macOS implementation
   and unsupported-platform stubs. Keep the unflagged local path intact. Add
   startup checks so an incomplete installation cannot enter a partial mode.
3. **Helper and workers.** Implement bounded local IPC, authentication, worker
   launch and lifecycle. Provide explicit `launchd` install/uninstall and
   recovery instructions; never perform privileged setup as part of tests by
   default. Helpers, workers and server must check protocol compatibility.
4. **Identity and host operations.** Add per-account sign-in/workspace routing
   and worker-backed operations, beginning with terminals. Complete the
   coverage inventory or fail closed for each unsupported feature. Extract
   interfaces as needed, not a wholesale frontend rewrite.
5. **Live validation and documentation.** Test with two real local accounts
   after operator approval. Document setup, access policy, experimental limits,
   disabling the flag, uninstalling the helper and recovering the legacy setup.
   Update sign-in, deployment, architecture and release notes without implying
   Linux/Windows support or changing defaults.

## Acceptance tests

- **Compatibility:** absent/false flag preserves all existing auth modes,
  workspaces, terminal behavior and deployment defaults. Invalid combinations
  and an enabled flag on unsupported systems fail clearly.
- **Identity:** two allowed macOS accounts obtain their own UID, groups, home,
  shell and environment. Account A cannot choose B's worker, workspace,
  terminal, transfer, attachment or kept session by changing API/IPC fields.
- **OS permissions:** A cannot read, overwrite or delete B's private test files,
  including through shortcuts, transfer requests or symlinks. Shared files
  follow ordinary macOS permissions; no extra access comes from the server.
- **Helper security:** reject unauthorized peers, untrusted binary/socket
  ownership, arbitrary UIDs, invalid/revoked grants and malformed requests.
  Confirm privilege dropping and supplementary groups, including an account
  with more than 16 directory-service group memberships.
- **Lifecycle:** reconnect retains intended work; pane/workspace destruction,
  startup cancellation and server shutdown release the correct resources.
  Another account/workspace stays functional. Helper/worker loss is visible
  and never triggers a local-account fallback.
- **Credentials and recovery:** incorrect/disallowed accounts, expired/revoked
  sign-ins, restart and recovery links cannot acquire an unauthorized worker.
  Passwords and grants are absent from logs and persistent application data.
- **GUI/network limits:** absent GUI sessions produce actionable errors, never
  another person's clipboard. Browser/screen access matches the documented
  policy; Remotr is not described as providing isolated per-account desktops.
- **Rollback:** removing the flag restores the legacy path with legacy data
  intact; helper removal is explicit and does not delete user workspaces/files.
- **Checks:** Go tests and vet, race checks for IPC/lifecycle code, applicable
  JavaScript tests, existing platform builds, and recorded opt-in macOS live
  results. Mock/cross-build success is not evidence of live Linux/Windows
  isolation support. Keep CI/CD triggers unchanged.

## Not in scope

Linux/Windows account isolation; automatic enrollment of existing installs;
default-on authentication/HTTPS; automatic legacy workspace migration; screen
single sign-on/password retention; native screen capture; and a broad frontend
or release-pipeline rewrite.
