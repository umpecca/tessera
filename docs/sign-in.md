# Sign-in

Sign-in is off until you turn it on in **Settings → Sign-in**, or start
Tessera with `-auth=system`, `-auth=file`, or CLI credentials.

## CLI account for one run

```sh
printf '%s\n' "$TESSERA_PASSWORD" | tessera \
  -addr 0.0.0.0:7331 -allowed-host studio.example.com \
  -username alice -password-stdin
```

Read `TESSERA_PASSWORD` from a secret manager or a hidden terminal prompt;
the [README example](../README.md#start-with-a-hostname-and-a-cli-sign-in) shows
the prompt and both HTTP/HTTPS addresses. Only the first stdin line is read;
LF/CRLF is removed, other whitespace is kept, and the password must be
1–1024 bytes. Empty/incomplete credentials fail startup rather than disabling
sign-in. `-password` is also supported, but **argument passwords can be seen in
process listings and shell history**; prefer `-password-stdin`. Do not supply both.

- These credentials supersede the saved sign-in mode and **all** saved accounts
  for this run. The CLI account is an admin; saved accounts, their remembered
  cookies and host-account cookies cannot bypass it. Existing saved accounts,
  passwords and sign-in preferences are not overwritten. Restart without CLI
  credentials to use the saved setup again.
- Settings shows that the account/password are CLI-owned and cannot change
  them or manage the dormant saved accounts. `tessera user` still manages the
  saved accounts on disk, but those changes do not affect the CLI override.
- Do not combine CLI credentials with `-users`, `-auth=off` or `-auth=system`.
  `-auth=file` may be supplied but is not needed and is not persisted when CLI
  credentials are present. Without CLI credentials, `-auth` retains its usual
  persisted behavior below.
- The CLI account sees workspaces belonging to its name, including existing
  ones with that name. No workspaces are moved. Terminals still run as Tessera's
  OS account; this is not OS-user isolation.
- Password transport restrictions, login throttling and signed-in-device
  controls still apply. `tessera login -account alice` can recover only the CLI
  account while the override is active, not a dormant saved account.
- CLI sign-ins are isolated from saved-account sign-ins and expire across a
  fresh process launch (even with the same username/password). Passwords are
  hashed in memory, not added to the account database.
- An automatic self-update restart cannot replay an already-consumed stdin
  password. With `-password-stdin`, restart manually and supply the password
  again after updating; a failed replacement handoff restores the current
  server without falling back to saved accounts.

Startup reports actual HTTP/Local HTTPS URLs (or disabled HTTPS) and effective
sign-in mode/account names on stdout; errors remain on stderr. Only enabled
listeners are reported as URLs. Allowing a hostname does not enable HTTPS or
alter DNS; configure Local HTTPS separately in Settings.

## Settings → Sign-in

**Require sign-in** offers Off, Tessera accounts (`file`) and Host account
(`system`). The choice is saved in the database and applies at once:

- While sign-in is off, anyone who can open Tessera may turn it on. Choosing
  Tessera accounts asks for an admin account: a new one is created, or an
  existing one is used if you enter its password. Choosing Host account asks
  for that account's password.
- Once it is on, only admins can change it. Turning it off asks for your
  password and warns when Tessera can be reached from other devices.
- Every change ends all earlier sign-ins. Turning sign-in on also closes
  connections opened without one, and other open pages go to the login page.
- Tessera accounts keep workspaces per account, while Off and Host account
  share one set. When a change moves you between them, **Bring my
  workspaces, settings and shortcuts along** moves yours, unless the other
  side already has workspaces.
- Starting Tessera with `-auth` sets the mode and saves it, and Settings
  can't change it while the flag is given. Drop the flag and the mode stays
  as it set it, now changeable in Settings again. So `-auth=off` once turns
  sign-in off for good, for instance when nobody can sign in any more.
- With Tessera accounts but no accounts yet, Tessera still starts and still
  requires sign-in, but nobody can sign in; the log and the login page say
  why. `tessera user add` on the host fixes it without a restart.
- Host account sign-in that can't work, because Tessera can't tell which
  account it runs as, stops Tessera from starting; start it with `-auth=off`.

With Tessera accounts, admins also see the accounts in this section: **Add
Account...**, **Password...** (ends that account's sign-ins; your own device
stays signed in), **Make Admin** / **Remove Admin**, and **Remove**. There is
always at least one admin, and you can't remove the account you're signed in
as. Setting passwords from another device needs HTTPS, as signing in does.

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

Every sign-in mode keeps a recovery token in Tessera's database. Someone on
the host who can read the database, as the account Tessera runs as, can:

```sh
tessera login -addr 127.0.0.1:7331             # prints a one-time link, valid 2 minutes
tessera login -addr 127.0.0.1:7331 -account alice   # with -auth=file
tessera logout -all -addr 127.0.0.1:7331       # ends every sign-in everywhere
```

Pass the server's `-addr` (a `0.0.0.0` address is reached through
`127.0.0.1`), and its `-db` when it isn't the default. These only work from
the host itself.

## Tessera accounts (`-auth=file`)

Accounts live in Tessera's database (`-db`), which Tessera makes readable
only by the account it runs as. Manage them in Settings or with:

```sh
tessera user add alice        # prompts for a password twice; the first account is an admin
tessera user add -admin carol # another admin
tessera user passwd alice     # ends alice's existing sign-ins
tessera user admin bob        # bob can manage accounts in Settings (-revoke undoes it)
tessera user remove alice     # ends alice's sign-ins; keeps her workspaces
tessera user list
printf '%s\n' "$PASSWORD" | tessera user add -password-stdin bob
```

Pass the server's `-db` to the commands when it isn't the default. Changes
apply to a running server without a restart. Passwords are stored as argon2id
hashes. These saved-account commands do not accept passwords as arguments;
the separate runtime `-password` option above does, with the stated risks.

Earlier versions kept accounts in a credentials file
(`<user config dir>/Tessera/credentials`, or `-auth-file`). The server and
`tessera user` import its accounts once, into a database without accounts,
and don't use the file after that.

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
