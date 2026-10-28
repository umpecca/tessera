# Tessera

Tessera is a local-first, text-first computer workspace. A Go host serves an
embedded browser application, persists desktops in SQLite, and provides local
shell, terminal, and filesystem capabilities. The interface uses movable,
resizable panes with BeOS-inspired window chrome and a Deskbar.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, data flow,
deployment details, and the security roadmap, and [CHANGELOG.md](CHANGELOG.md)
for recent changes.

## What it does

- **Terminals** that keep running on the host and restore their text and Sixel
  images when a browser reconnects; shell integration for prompt jumps, command
  output copying and "command finished" notices; scrollback search; window
  titles, progress bars, bells and notifications from programs; the Kitty
  keyboard protocol, synchronized output and colour queries; typing prediction
  for slow links; clipboard, image paste and links; launch shortcuts. See
  [Terminal panes](docs/terminal.md), [terminal audio](docs/terminal-audio.md),
  [file transfers](docs/terminal-files.md) and the
  [terminal core](docs/terminal-core.md).
- **A desktop of windows** you draw, move, resize, minimize and reorder, with a
  command palette (`Ctrl+K`/`Cmd+K`), a Command Wheel, a window list, themes,
  and named sessions per user. See [Workspace](docs/workspace.md).
- **Browser panes** that show a development server on the host through
  Tessera's own listener. See [Browser pane](docs/browser-pane.md).
- **VNC and RDP panes** for remote desktops, with H.264 video, full color
  (4:4:4), sharp Retina rendering and RDP sessions kept on the host. See
  [VNC and RDP panes](docs/vnc-and-rdp.md).
- **Phone and iPad** use: a phone view of your terminals, touch controls, a Home
  Screen web app and Local HTTPS. See [Remote access](docs/remote-access.md).
- **Optional sign-in** with the host account or Tessera accounts. See
  [Sign-in](docs/sign-in.md).

## Security and trusted-environment status

Tessera is currently intended for use by one operator or a small group in a
trusted environment. [Sign-in](docs/sign-in.md) is available but off by default, and
Tessera has no authorization beyond it.

This is an important operational boundary:

- Without sign-in, anyone who can reach Tessera controls the host account it
  runs as. With `-auth=system` or `-auth=file`, a password is required, but
  every signed-in account still runs terminals as that same host account, so
  file accounts separate workspaces without isolating people from each other.
- The `-users` roster and named sessions separate workspace state; they do not
  verify identity or prevent one connected user from selecting another user.
- The HTTP API can execute shell commands and read, write, copy, move, or
  delete files available to the Tessera process.
- The default listener is `127.0.0.1`, which limits access to the host machine.
- Binding to `0.0.0.0` exposes Tessera to the network. Do this only on a
  trusted, appropriately isolated network whose users are allowed to control
  the host machine.
- Tessera rejects cross-origin browser mutations, ignores forwarding headers
  from untrusted peers, applies security response headers, rate-limits API
  requests by client IP, and can optionally record redacted mutation/Terminal
  audit events.
  These controls reduce common HTTP risks but do not authenticate a client or
  authorize what it may do.
- Optional [Local HTTPS](docs/remote-access.md#local-https-for-ipados) provides TLS using Tessera's
  private certificate authority. It does not add authentication or authorization;
  direct public-internet exposure remains unsupported.

- Tessera answers only to IP addresses, `localhost`, the machine's own name
  (and `.local` name), the Local HTTPS certificate's names, and names given with
  `-allowed-host`. Other names get `421`, which blocks DNS-rebinding attacks
  from web pages. If you reach Tessera by another DNS name, such as a Tailscale
  MagicDNS name or a reverse proxy's name, add it with `-allowed-host`.

Without sign-in, network reachability should be treated as trusted access to
the host.

## Run

Run from the repository root:

```powershell
go run ./cmd/tessera
```

Then open:

```text
http://127.0.0.1:7331
```

Returning browsers show the last theme for that user while the saved session
restores, then reveal the workspace with keyboard focus ready. Slow startup
shows a quiet loading message; failed startup offers **Reload Tessera**.

The SPA is embedded in the binary, so a built executable can run from any
directory. During frontend development, serve the working `web/` directory:

```powershell
go run ./cmd/tessera -web .\web
```

Useful flags:

```text
-addr string    listen address (default 127.0.0.1:7331)
-db string      SQLite database path
-tray bool      enable native tray controls when supported
-users string   comma-separated local workspace roster
-auth string    sign-in: off (default), system, or file
-auth-file string             credentials file for -auth=file
-auth-token string            host recovery token for `tessera login` / `logout`
-allow-http-sign-in bool      accept passwords over plain HTTP from other devices
-signin-idle duration         unused time before a remembered sign-in ends (default 720h)
-signin-max duration          longest a remembered sign-in lasts (default 2160h)
-web string     serve SPA assets from a directory instead of the embedded copy
-trusted-proxy value          trusted immediate proxy IP/CIDR (repeatable)
-allowed-host value           extra DNS name Tessera answers to (repeatable)
-rate-limit int               API requests per client per minute (default 600)
-rate-burst int               per-client API burst (default 120)
-audit-log bool               persist redacted audit events (default false)
-audit-retention-days int     enabled audit retention in days (default 30)
-max-upload-size int          maximum bytes per terminal file upload (default 1073741824)
-rdp-idle-limit duration      how long a kept RDP session lasts with no browser attached (default 8h)
```

For example:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -db .\tessera.sqlite3 -web .\web
go run ./cmd/tessera -users alice,bob,carol
```

## Install as an Ubuntu service

On an Ubuntu amd64 or ARM64 host, download and run the installer as root:

```bash
curl --fail --location \
  https://raw.githubusercontent.com/umpecca/tessera/main/scripts/install-ubuntu.sh \
  --output install-ubuntu.sh
sudo bash install-ubuntu.sh
```

It installs the latest release as `tessera.service`, running as the account
that invoked `sudo`, and asks for a listen address (`127.0.0.1` by default).
Run it again to update. [Deployment](docs/deployment.md) covers the service,
reverse proxies and HTTP hardening, tray builds and macOS notes.

## Documentation

- [Terminal panes](docs/terminal.md), [terminal audio](docs/terminal-audio.md),
  [terminal file transfers](docs/terminal-files.md),
  [terminal core](docs/terminal-core.md)
- [Workspace](docs/workspace.md), [Browser pane](docs/browser-pane.md),
  [VNC and RDP panes](docs/vnc-and-rdp.md)
- [Remote access](docs/remote-access.md) (iPad, phone view, Local HTTPS),
  [Sign-in](docs/sign-in.md)
- [Deployment](docs/deployment.md), [Development and releases](docs/development.md)
- [Firefox clipboard extension](docs/firefox-clipboard.md) (for Firefox 115 ESR)
- [Known issues](docs/known-issues.md): two terminal graphics problems remain
  open, occasional stalls in Chrome on Windows and rare canvas corruption.

## Development

```sh
npm install && npm run build:web
go test ./... && go vet ./...
```

[Development and releases](docs/development.md) has the full checks, the
vendored bundles, benchmarks, migrations, and how releases and self-update work.
