# Task 081: Run the Ubuntu service as the invoking user

Status: complete

Update the Ubuntu installer so Tessera runs as the non-root account that
invoked the installer through `sudo`, rather than as a dedicated system user.

- Require a valid, non-root `SUDO_USER` and fail clearly when the installer is
  run directly as root.
- Run the systemd service with the invoking user's primary group and home as
  its working directory.
- Preserve the database under `/var/lib/tessera` and transfer ownership of
  existing state to the invoking user during upgrades.
- Allow Tessera terminals to access the user's home and use that user's
  existing `sudo` permissions.
- Do not automatically delete a previously created `tessera` system account.
- Document the broader filesystem and privilege boundary.
- Validate the installer syntax and project tests.

Implemented service-user discovery from `SUDO_USER`, validation of the user,
primary-group and home-directory lookup, and creation of a missing configured
home. The generated unit now runs as that user from their home with `HOME` set.
Removed the systemd restrictions that blocked home access and privilege
elevation. Existing `/var/lib/tessera` state is recursively transferred to the
selected account during installation; a legacy `tessera` account is left
untouched. Updated the README and changelog with the expanded authority and
security implications.

Validation:

- Git for Windows Bash accepts `scripts/install-ubuntu.sh` with `bash -n`.
- Static installer checks confirm invoking-user selection, home use, state
  migration, removal of user creation, and removal of the relevant sandbox
  restrictions.
- `go test ./...` passes.
