# Task 244: Sign in as yourself

Status: paused (2026-10-30). Phase 0 is done on macOS (see "Spike results"); the Linux checks and the "Decisions to confirm" are open. The test platforms it needs are task 245.

## Request

Let anyone with an account on the machine sign in to Tessera with that
account's own password, so the link can be shared with another person. What
they do in Tessera runs as their account, never as Tessera's: their shell,
their files, their commands. The screen pane opens their own desktop the
same way, without a second sign-in. This is item 1 of the roadmap in
VISION.md.

The two halves ship together. Signing in as Bob but getting a shell as the
account Tessera runs as would be worse than today.

## Findings (2026-10-30, from the code)

### Sign-in

- Host-account sign-in (`-auth=system`) accepts exactly one account: the one
  Tessera runs as. `attemptSignIn` replaces the typed name with
  `opts.SystemAccount`, the login page shows it fixed, and `accountCurrent`
  ends any sign-in for another name (`internal/httpapi/auth.go`).
  `sysauth.Verify` documents the same limit (`internal/sysauth/sysauth.go`).
- How each OS checks a password today, and what changes:
  - **Linux:** PAM's `unix_chkpwd` helper (`verify_linux.go`). It checks the
    password of the account that runs it, not any other, unless that is
    root.
  - **macOS:** OpenDirectory through purego (`verify_darwin.go`). It may
    already be able to check other local accounts (to verify).
  - **Windows:** `LogonUserW` (`verify_windows.go`). It works for any
    account, and returns a token that could start that account's processes.
- Tessera accounts (`-auth=file`) already keep workspaces, settings,
  shortcuts and kept RDP sessions per account. Off and Host account share one
  set (docs/sign-in.md). The per-account storage exists; host sign-in doesn't
  use it yet.
- `-users` (the roster) works with host sign-in, but not with `-auth=file`,
  because each account is its own user there.

### What touches the host, all as Tessera's own account

- **Terminals:** `startPlatformPty` runs `$SHELL` with Tessera's
  environment (`internal/terminal/session_unix.go`).
  - The terminal manager keeps the PTY, the parser core (wazero), replay and
    scrollback in Tessera's process (`internal/terminal/manager.go`).
  - `Close` kills the process (`session_unix.go:89`), which an unprivileged
    process can't do to another account's processes.
- **Shortcuts:** launch shortcuts start in a terminal
  (`internal/terminal/shortcut_shell.go`). `httpapi/shortcuts.go` checks the
  working directory with `os.Stat`.
- **Files:**
  - saving and deleting host files (`httpapi/host_files.go`),
  - attachments in a directory Tessera creates (`attachments.go`),
  - uploads and downloads with temporary files and renames
    (`file_transfers.go`, `terminal_files.go`),
  - the folder picker (`directories.go`),
  - the terminal file broker (`internal/terminalfile/broker.go`).
- **Clipboard and open:** `pbcopy`/`wl-copy`/`xclip`-style tools
  (`internal/hostclipboard`) and `open`/`xdg-open` (`internal/desktop`).
  Both need a desktop session belonging to the account.
- **Self-update and restart** replace Tessera's own binary
  (`internal/update`).
- **Browser pane:** it can reach any port on this machine's loopback, so one
  account can reach another account's dev servers.
- **RDP and VNC are network only:** they never touch the host's files or
  processes. But the screen server asks for its own login, so which desktop
  you get is whatever you type there, not your Tessera account.
  - The kept RDP client, the IronRDP module under wazero, runs in Tessera's
    process (`internal/rdpsession`).
  - It takes the password once and wipes it after reading it (patch 0005).

### Installation

- Tessera runs as one user. Its database defaults to that user's config
  directory (`os.UserConfigDir`, `internal/server/server.go`). The PKI and
  RDP module cache sit beside the database.
- The Ubuntu installer's systemd unit runs as a chosen service user, and must
  not set `NoNewPrivileges` or `RestrictSUIDSGID` because of `unix_chkpwd`
  (`scripts/install-ubuntu.sh`). There is no macOS daemon setup.

## Design (proposed)

Privilege separation, as in `sshd` and Cockpit.

1. **Single-account Tessera doesn't change.** Run as an ordinary user, it
   works exactly as today, with only its own account. Several accounts
   require the system-service install.
2. **Three processes:**
   - **`tessera` (the server)** runs as an unprivileged service account
     (`_tessera` on macOS, `tessera` on Linux). It holds HTTP, workspaces,
     the terminal machinery, RDP and the Browser pane. It never touches
     another account's files or processes itself.
   - **`tessera helper`** runs as root and does three things only: check
     a password, start an account's worker, and stop it. Its only interface
     is a Unix socket that only the server can open.
   - **`tessera worker`** runs as the signed-in account, with that
     account's uid, groups, `HOME`, shell and login environment. Everything
     that touches the host goes through it.
3. **Terminals: the worker starts the shell, the server keeps the rest.** The
   worker opens the PTY, starts the account's shell, and hands the PTY's
   master file descriptor to the server over the socket (`SCM_RIGHTS`).
   - The terminal manager, parser core, replay, scrollback and audio stay as
     they are; only `startPlatformPty` gains a "start through this worker"
     path.
   - Closing the master hangs up the shell, as now. A forced kill is asked
     of the worker.
   - The server sets the received descriptor non-blocking. The worker
     closes its own copy once it's sent, and reports the shell's exit
     status, which the server can't collect (see "Spike results").
   - `terminal.Start`'s directory check and default directory move into the
     worker, with the account's home as the default. The shell integration
     scripts are written by the worker into the account's own cache
     directory: today they go in the server account's cache
     (`shellintegration.Root`), which another account can't read.
4. **Files through a `HostFS` interface.** The file routes call an interface
   with two implementations:
   - a local one: today's code, for single-account Tessera,
   - a worker one: RPCs for stat, read directory, open for reading, create
     temporary, rename, remove and make directory.

   The OS then enforces the account's own permissions, and Tessera adds
   none.
5. **Who can sign in:**
   - Members of a `tessera` group, plus admins: members of `admin` on macOS,
     and `sudo` or `wheel` on Linux.
   - Never root.
   - Never system accounts (below the OS's first regular uid).
   - Admins also manage Tessera's own settings: sign-in mode, HTTPS and
     updates.
6. **The helper doesn't take the server's word for anything:**
   - It starts a worker only after it has checked that account's password
     itself.
   - A check returns a per-sign-in key, which the helper keeps hashed. The
     server presents that key to reach the worker again, so a remembered
     sign-in works after a restart.
   - Signing out, or a password change, retires the key.
   - A compromised server can therefore reach only accounts that are signed
     in, never an arbitrary one.
7. **Checking any account's password:**
   - **Linux:** the helper runs `unix_chkpwd` for the account, as root.
     Run by root it skips the "same account" rule. Run by anyone else it
     checks only the caller's own password, so it needs no cgo either way.
     Its `chkexpiry` mode then checks for expired and locked accounts.
   - **macOS:** OpenDirectory, run by the helper. It already evaluates
     another account's password without root, but the helper still does the
     check, so that it issues the key (item 6).
   - **Windows:** `LogonUserW`, later.
8. **Workers live as long as their sessions.** Terminals and kept RDP
   sessions already outlive a browser's connection and a sign-in's end
   (docs/sign-in.md), and this stays true. A worker with no terminals, no
   kept sessions and no sign-ins exits. Restarting Tessera ends both, as it
   does now.
9. **Workspaces per account.** Each host account gets its own workspaces
   and settings, as Tessera accounts do. The account Tessera ran as before
   keeps today's shared set. `-users` keeps offering its picker within an
   account.
10. **The screen pane opens your own desktop** by passing your sign-in to
    this machine's screen server, as Guacamole's pass-through does.
    - Your worker keeps the password you signed in with, in memory only,
      never on disk.
    - The screen pane connects to the local RDP (or VNC) server with your
      account name and that password, so no sign-in dialog appears.
    - The kept RDP client moves from the server into your worker. The
      password then never leaves a process running as you, and the session
      is yours as your terminals are. The server only relays the picture
      and input between the worker and the browser.
    - After a restart, a remembered sign-in gets you in without a password,
      but your worker no longer has it. The screen pane then asks for your
      password once.
    - Whether each account gets its own desktop is up to the screen server:

      | Machine | Separate desktop per account? |
      | --- | --- |
      | Linux, xrdp | Yes, a session per login |
      | Windows Server | Yes, several sessions at once |
      | Windows Pro | One at a time; signing in takes over the console |
      | macOS, Remotr | No. It shares the Mac's one screen; its RDP sign-in only lets you connect, and you then sign in at the login window (see "Spike results") |
      | macOS, Screen Sharing (VNC) | Possibly (Apple's help describes a Log In choice for a second remote user), but not pursued: VNC is kept for QEMU machines, not the Mac's desktop |

      **Decided (2026-10-30): on a Mac, the screen pane shows the Mac's one
      screen** through Remotr, and you sign in at its login window. There's
      no pass-through there. Pass-through applies where the screen server
      gives each account its own desktop: xrdp on Linux, and Windows Server.
      Screen Sharing's Log In session might give Macs that too, but it would
      need VNC brought up to RDP's standard first. VNC is kept for QEMU
      machines, so this isn't pursued.
    - Native capture inside the worker (roadmap item 9) is the eventual
      form: no screen server, and no password passed on.

## Spike results (phase 0, 2026-10-30, on this Mac)

The probes are in the session scratchpad,
`/private/tmp/claude-502/-Volumes-Data-projects-tessera/f7b61bb6-af37-4a46-8d23-56088e22bf75/scratchpad/spike244/`:

- `ptyspike` hands a PTY from a worker to an unprivileged server.
- `odspike` checks macOS passwords.
- `chkspike` checks Linux passwords, with Linux builds of both under
  `linux-amd64/` and `linux-arm64/`.

### Done without root

1. **PTY hand-off: works.** A worker process started the shell and passed
   the PTY master over a Unix socket (`SCM_RIGHTS`) to a separately started
   server process. Over the passed descriptor:
   - **Typing and output** worked.
   - **Resizing** worked: `TIOCSWINSZ` from the server gave `43 132` in
     `stty size`, and the shell got `SIGWINCH`.
   - **OSC 7** came through unchanged, so directory tracking from shell
     integration needs nothing new.
   - **`exit 7`** ended the stream with EOF.

   Three rules come out of it:
   - **The server can't collect the exit status.** `wait4` on the shell
     fails with "no child processes", because it isn't the server's child.
     The worker must report it; here it reported `exit 7`.
   - **The worker must close its copy** of the master after sending it.
     While it keeps one, the server closing its own doesn't hang up the
     shell.
   - **The server must make the received descriptor non-blocking.** If it
     doesn't, a pending `Read` holds Go's `Close` back, the descriptor
     never closes, and the shell is never hung up. Set non-blocking, closing
     it gave the shell `SIGHUP` (it exited 129).

   **Confirmed across accounts** (`sudo ptyspike run gofffamily`,
   2026-10-30):
   - The worker and shell ran as `gofffamily` and the server as `nobody`
     (uid −2).
   - Typing, resizing, `SIGWINCH` and OSC 7 worked the same.
   - `wait4` gave "no child processes", and the worker reported `exit 7`.
   - `kill(shell, 0)` from the server gave "operation not permitted", so a
     forced kill has to go through the worker.
   - Closing the master hung up the shell (exit 129) only with both rules
     kept. With the worker keeping its copy, or a blocking descriptor, the
     shell kept running.
2. **macOS passwords: OpenDirectory checks other accounts without root.**
   A deliberately wrong password got the same answer, code 5000 ("user name
   or password is invalid"), for `jaxdad`, which runs it, and for
   `gofffamily`. That means it evaluated `gofffamily`'s password rather
   than refusing to. An unknown account isn't found. One wrong attempt was
   made against `gofffamily`.

   **Confirmed with correct passwords** (run by `jaxdad`, 2026-10-30):
   `verified=true` for `jaxdad` and for `gofffamily` as uid 502, and for
   `gofffamily` as root.
3. **Linux passwords, from `unix_chkpwd`'s source** (linux-pam,
   `modules/pam_unix/unix_chkpwd.c`):
   - **Root** skips the check that the requested account is the caller's.
   - **Anyone else** asking about another account gets privileges dropped,
     so the check can't read the shadow file.
   - **Modes:** `nonull`/`nullok` to verify, `chkexpiry` for expiry.

   So the helper runs it as root, directly. Still to run on a real Linux
   machine.
4. **Screen servers are found by their handshake.**
   - **Screen Sharing** answered on 5900 with `RFB 003.889`, Apple's
     variant.
   - **Remotr** answered on 3389 with an X.224 connection confirm that
     selects CredSSP (NLA).

   Detection by handshake (VISION.md, "The Screen pane") works on this Mac.
5. **Remotr is built the way this task proposes.** Its launchd setup has:
   - a root service on port 3389 (`/Library/LaunchDaemons/com.remotr.service.plist`),
   - an agent in every user's GUI session (`com.remotr.session-aqua`,
     limited to `Aqua` sessions),
   - one on the login window (`com.remotr.session-login`).

   **Tried (2026-10-30): Remotr shares the Mac's one screen.** Connecting
   as either `jaxdad` or `gofffamily` led to the Mac's login window, where
   you choose a user and sign in again. The RDP sign-in only decides who
   may connect, like the built-in Screen Sharing. The per-session agents
   follow the screen between the login window and whoever is signed in;
   they don't give accounts desktops side by side. So:
   - Pass-through to Remotr gets you past its RDP check only, not onto your
     desktop.
   - Two people can't each have a desktop through it at the same time.
6. **macOS Screen Sharing:**
   - Apple's help says a second remote user is offered Share Display or
     Log In, for their own screen alongside the other user's.
   - `gofffamily` is in `com.apple.access_screensharing`, so it may
     connect.
   - Both `jaxdad` and `gofffamily` are admins.
7. **macOS caps a process at 16 groups.** `setgroups` refuses more than
   `NGROUPS_MAX` (16), and both `jaxdad` and `gofffamily` are in 18. So the
   worker can't simply copy every group. The first cross-account run hung
   because starting the worker failed this way. The real worker should use
   `initgroups`, which on macOS leaves membership beyond 16 to the
   directory service (to verify). Linux allows 65536.
8. **From the code:**
   - `terminal.Start` checks the working directory with `os.Stat` and falls
     back to `os.Getwd()`, both as the server; this moves into the worker.
   - The shell integration scripts are written to the server account's
     cache directory, which another account's shell can't read; the worker
     writes them instead.

### Still to do, needing a password, root or another machine

Run these in your own terminal, so passwords stay there. Each prints results,
never the password. `SP` is `/tmp/tessera-spike244`, a copy that other
accounts can run, since the scratchpad is private to `jaxdad`.

1. ~~**PTY hand-off across accounts**~~ (done, see result 1):
   `sudo $SP/ptyspike run
   gofffamily`. The worker runs as `gofffamily` and the server as `nobody`.
   Expected:
   - `USER=gofffamily`,
   - the same resize and hang-up results as above,
   - `serverKill` showing "operation not permitted", which confirms that the
     server can't kill the account's shell and the worker has to.
2. ~~**A correct password for another account**~~ (done, see result 2):
   `$SP/odspike -ask
   gofffamily`, then with `sudo`. Use `-ask jaxdad` as a control.
3. ~~**Remotr with two accounts**~~ (done, see result 5): with `jaxdad` logged in at the Mac (or
   nobody), connect an RDP pane as `gofffamily`. Do you get its own desktop,
   `jaxdad`'s, or does the Mac's screen switch?
4. ~~**Screen Sharing with two accounts**~~ (skipped, see item 10 of the
   design): connect a VNC pane as
   `gofffamily`. Is Log In offered, and does it give a separate session?
   Tessera's VNC pane may need to answer that prompt itself.
5. **Linux:** copy `linux-amd64/` or `linux-arm64/` over, then:
   - run `chkspike -ask <you>` and `chkspike -ask <other>`, as yourself and
     with `sudo`,
   - run `sudo ptyspike run <other>`,
   - try xrdp, if installing it is fine: does it sign in from IronRDP's
     credentials without its own login screen?

## Plan

0. **Spike, before committing to the design** (results so far under
   "Spike results"):
   - Done: the PTY hand-off for one account, macOS's check of another
     account (wrong password), `unix_chkpwd`'s rule from its source, and
     screen server detection.
   - Also done on macOS: a correct password for another account, and the
     PTY hand-off across accounts.
   - Skipped: Screen Sharing with two accounts (VNC is kept for QEMU).
   - To do: Linux on a real machine, and xrdp.
   - Screen servers with two accounts:
     - Remotr: does each Mac account get its own desktop, or the one at the
       screen?
     - macOS Screen Sharing: does "Log in as yourself" give the second
       account its own session, and can a VNC client choose it without the
       dialog?
     - xrdp: does it sign in straight to the session from IronRDP's
       credentials, with no login screen?
1. **The helper, the worker and terminals on Linux and macOS.**
   - Sign-in for allowed accounts, per-account workspaces.
   - The Linux installer's units: the server as `tessera`, the helper as
     root.
   - A macOS LaunchDaemon setup.
   - The login page asks for a name in this mode.
2. **Your desktop:**
   - the kept RDP client in the worker,
   - the password held in the worker,
   - the screen pane connecting as you, and asking once after a restart,
   - Linux (xrdp) and Windows Server, where each account has its own
     desktop. On a Mac the screen pane shows the Mac's one screen, and the
     Remotr sign-in dialog is filled in with your account name.
3. **Files through the worker:** host files, attachments, uploads and
   downloads, the folder picker and the terminal file broker.
4. **The rest:**
   - Clipboard and open, through the worker. Where the account has no
     desktop session, say so rather than fail without explaining.
   - Browser pane ports per account. Linux can read socket owners from
     `/proc/net/tcp`; for macOS, ask the helper.
   - Admin-only settings, and self-update done by the helper.
5. **Windows:** a service as LocalSystem, `CreateProcessAsUser` with the
   token from `LogonUserW`, and ConPTY handles duplicated to the server.

Each phase updates docs/sign-in.md, docs/deployment.md, and the security
section of ARCHITECTURE.md.

## Decisions to confirm

- Keeping your password in your worker's memory for pass-through. It's the
  price of not signing in twice. A compromised worker already runs as you,
  but the password may also open other machines that share it.

- The group's name (`tessera`), and whether admins are allowed in without
  joining it.
- Whether signing out everywhere should also end that account's terminals.
  Today it doesn't.
- On a headless Mac nobody is logged in at the screen, so clipboard and open
  won't work for anyone. Is "unavailable, with a reason" enough?
- The service account's name, and where the system install keeps its
  database: `/var/lib/tessera` on Linux, `/Library/Application
  Support/Tessera` on macOS.
- How an existing single-account install moves to the system service.
  Moving its database and certificates means re-trusting HTTPS on each
  device unless the certificates move too.

## Not covered

- Per-account limits on CPU, memory or disk. The OS's own controls apply.
- Accounts from a directory service (LDAP, Active Directory) beyond what the
  OS already resolves. They work if the OS knows them, but this task won't
  test them.
