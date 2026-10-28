# Sign-in

Sign-in is off unless you start Tessera with `-auth=system` or `-auth=file`.

## The host account (`-auth=system`)

```sh
tessera -addr 0.0.0.0:7331 -auth=system
```

The login page asks for the password of the account Tessera runs as, and no
other account. `-users` still offers its workspace picker after sign-in, and
single-user workspaces stay as they are. Passwords are checked without cgo:

- **macOS:** OpenDirectory, as the login window does.
- **Linux:** PAM's `unix_chkpwd` helper. It is setuid, so a systemd unit must
  not set `NoNewPrivileges=true` or `RestrictSUIDSGID=true`; the Ubuntu
  installer's unit does not.
- **Windows:** `LogonUserW`. Accounts without a password cannot sign in this
  way.

## Getting in without a password

Every sign-in mode keeps a private recovery token beside the credentials file
(`-auth-token`). Someone on the host, as the account Tessera runs as, can:

```sh
tessera login -addr 127.0.0.1:7331             # prints a one-time link, valid 2 minutes
tessera login -addr 127.0.0.1:7331 -account alice   # with -auth=file
tessera logout -all -addr 127.0.0.1:7331       # ends every sign-in everywhere
```

Pass the server's `-addr` (a `0.0.0.0` address is reached through
`127.0.0.1`). These only work from the host itself.

## Tessera accounts (`-auth=file`)

Accounts live in a credentials file that only the host account can read (default
`<user config dir>/Tessera/credentials`; `~/Library/Application
Support/Tessera/credentials` on macOS). Manage them with:

```sh
tessera user add alice        # prompts for a password twice
tessera user passwd alice     # ends alice's existing sign-ins
tessera user remove alice     # ends alice's sign-ins; keeps her workspaces
tessera user list
printf '%s\n' "$PASSWORD" | tessera user add -password-stdin bob
```

Pass `-auth-file` to the commands and the server when the file lives
elsewhere. Changes apply to a running server without a restart. Passwords are
stored as argon2id hashes and are never accepted as command arguments.

```sh
tessera -addr 0.0.0.0:7331 -auth=file
```

- Each account signs into its own workspaces, so `-users` cannot be combined
  with `-auth=file`. An account with the same name as an earlier `-users`
  entry gets that user's workspaces; an account named `default` gets the
  workspaces from single-user mode.
- "Keep me signed in on this device" lasts 30 days without use and 90 days at
  most; otherwise a sign-in ends after 12 hours without use or 7 days.
- In both modes, repeated wrong passwords from one address are slowed down, up
  to a 15-minute wait.
- Browsers can save and fill the sign-in with their password manager. The
  login page is an ordinary form they recognize; the panel that asks you to
  sign in again when a sign-in ends offers the login to Chrome and Edge once it
  works, named "*name* — Tessera". RDP window logins can be saved the same way,
  under the same website, named with their server.
- Passwords are refused over plain HTTP from other devices. Use
  [Local HTTPS](remote-access.md#local-https-for-ipados), or, on a link that is already
  encrypted such as Tailscale or another VPN, start the server with
  `-allow-http-sign-in`.
- **Sign out** is in the desktop menu and the command palette.
- **Settings → Signed-in devices** lists this account's sign-ins, with Sign
  Out for each and Sign Out Everywhere.
- When a sign-in ends (signed out elsewhere, expired, or its password
  changed), open terminal, VNC and RDP connections close, and the workspace shows a
  sign-in dialog. Signing in there reconnects the same terminals; their
  programs keep running throughout, and pending changes are saved.
- With `-audit-log`, sign-ins, failures, throttling, sign-outs and recovery
  links are recorded with the sign-in's ID, never passwords or cookies.
- [Kept RDP sessions](vnc-and-rdp.md#kept-rdp-sessions) need sign-in: each belongs to the
  account that kept it.
