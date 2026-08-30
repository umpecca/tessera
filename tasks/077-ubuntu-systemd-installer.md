# Task 077: Ubuntu systemd installer

Status: complete

Add a shell installer for supported Ubuntu x86_64 and ARM64 hosts that installs
the latest Tessera GitHub Release and configures Tessera to start at boot.

- Publish a CGO-free `tessera-linux-arm64` artifact alongside the existing
  `tessera-linux-amd64` artifact so Ubuntu VMs on Apple Silicon Macs are
  supported.
- Require root privileges and fail clearly on unsupported operating systems or
  CPU architectures.
- Detect `x86_64`/`amd64` and `aarch64`/`arm64`, then download the matching
  latest `tessera-linux-amd64` or `tessera-linux-arm64` asset from the public
  `umpecca/tessera` GitHub Releases page with redirect and HTTP error handling.
- Install the executable atomically in `/usr/local/bin`.
- Run Tessera as a dedicated, unprivileged system user with persistent state in
  `/var/lib/tessera`.
- Install a hardened `tessera.service` systemd unit that listens on
  `127.0.0.1:7331`, restarts after failures, and starts during normal boot.
- Make repeated installer runs safe and restart the service onto the newly
  downloaded version.
- Document installation, service management, defaults, and supported
  architectures in `README.md`.
- Add lightweight validation for the installer and systemd unit where
  practical without requiring a live systemd host.

Implemented `scripts/install-ubuntu.sh` with Ubuntu/root checks, amd64 and ARM64
asset selection, HTTPS download retries, atomic executable installation, an
unprivileged service account, persistent state, and an idempotently installed
and enabled systemd service. Added the Linux ARM64 release matrix entry and
documented installation, SSH access from a VM host, service management, and the
service filesystem boundary.

Validation: `bash -n scripts/install-ubuntu.sh` and `go test ./...` pass.
