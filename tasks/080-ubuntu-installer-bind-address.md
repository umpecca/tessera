# Task 080: Ubuntu installer bind address prompt

Status: complete

Update the Ubuntu installation script so the operator can choose whether
Tessera listens only on the local host or on every network interface.

- Prompt during installation for either `127.0.0.1` or `0.0.0.0`.
- Keep `127.0.0.1` as the safe default when the operator accepts the default.
- Validate the response and continue prompting until a supported choice is
  entered.
- Write the selected address into the generated systemd service command.
- Keep repeat installations and non-interactive failure behavior clear.
- Update installation documentation and lightweight installer validation as
  needed.

Implemented an interactive, validated listen-address prompt in
`scripts/install-ubuntu.sh`. Pressing Enter selects `127.0.0.1`; entering
`0.0.0.0` exposes the service on all interfaces; invalid values prompt again.
Non-interactive installation safely selects localhost. The generated systemd
unit and completion message use the selection, with a firewall warning for the
all-interfaces option. Updated the README and changelog accordingly.

Validation: Git for Windows Bash accepts the installer with `bash -n`, and
`go test ./...` passes.
