# Task 085: Service-aware self-update under systemd

Status: complete (live Ubuntu systemd check outstanding)

The ordinary self-updater replaces the running executable as the service user
and spawns its own successor. An Ubuntu installer deployment instead has a
root-owned `/usr/local/bin/tessera` and lifecycle ownership in
`tessera.service`, so that path cannot update safely.

## Requirements

- Detect the installer-provided systemd service explicitly, while recognizing
  existing installations created before the marker was added.
- Never run the ordinary unprivileged executable swap for a detected service.
- Ask for `sudo` in a visible Tessera Terminal instead of granting the HTTP
  handler passwordless root access.
- Run the privileged updater as a transient systemd unit so it survives the
  restart of `tessera.service` and remains outside that service's cgroup.
- Reuse the existing release check, asset validation, transactional install,
  and companion update rather than executing a mutable installer script.
- Preserve the existing unit, user, database, arguments, and listen address.
- Wait for the expected new server version and reload the browser after it is
  healthy.
- Leave direct desktop/server self-update behavior unchanged.
- Document recovery and the external-shell alternative.

## Verification

- `node --test web/*.test.mjs` (142 tests passed)
- `go test ./...`
- `npm run build:web`
- `bash -n scripts/install-ubuntu.sh` using Git for Windows Bash
- Linux amd64 cross-compilation of `internal/update` tests and `cmd/tessera`
- Release workflow coverage for matching Linux amd64 and arm64 LAME companions,
  so the transactional service update can resolve every published Linux asset
- `actionlint` validation of `.github/workflows/release.yml`
- Unit coverage includes explicit and legacy-cgroup service detection,
  platform boundaries, POSIX command quoting, root enforcement, refusal of the
  ordinary service-process `Apply`, no-op current-version behavior, and the
  ordered systemd restart/health verification calls.

Not run locally: a live transient-unit update. The available Windows host has
neither WSL nor a Linux systemd VM. The first deployment should verify the sudo
prompt, survival of the transient unit across the service cgroup shutdown, and
automatic browser reload against an Ubuntu installer deployment.
