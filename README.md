# Tessera

Tessera is a local-first, text-first computer workspace. A Go host serves an
embedded browser application, persists desktops in SQLite, and provides local
shell, terminal, and filesystem capabilities. The interface uses movable,
resizable panes with BeOS-inspired window chrome and a Deskbar.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, data flow,
deployment details, and the security roadmap.

## Security and trusted-environment status

Tessera is currently intended for use by one operator or a small group in a
trusted environment. It does not yet provide authentication or robust
authorization.

This is an important operational boundary:

- The `-users` roster and named sessions separate workspace state; they do not
  verify identity or prevent one connected user from selecting another user.
- The HTTP API can execute shell commands and read, write, copy, move, or
  delete files available to the Tessera process.
- The default listener is `127.0.0.1`, which limits access to the host machine.
- Binding to `0.0.0.0` exposes Tessera to the network. Do this only on a
  trusted, appropriately isolated network whose users are allowed to control
  the host machine.
- Tessera does not currently terminate TLS. Do not expose it directly to the
  public internet.

Future security work is expected to add real authentication, robust
authorization for users, sessions, files, commands, and administrative
operations, request-forgery protection, and an auditable access model. Until
that work exists, network reachability should be treated as trusted access to
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
-web string     serve SPA assets from a directory instead of the embedded copy
```

For example:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -db .\tessera.sqlite3 -web .\web
go run ./cmd/tessera -users alice,bob,carol
```

## Workspace model

Tessera presents a full-window desktop where panes can overlap and retain
their geometry, z-order, title, working directory, font size, and content.

Current pane types:

- **Worksheet:** a CodeMirror-backed editable command worksheet. Run the
  selection or current line with `Ctrl+Enter`/`Cmd+Enter`; streamed output is
  inserted as editable text below the command.
- **Terminal:** a persistent PTY terminal using ConPTY on Windows and a Unix
  PTY on macOS/Linux. Terminal sessions retain bounded scrollback while the
  server process remains alive.
- **Text Editor:** a file-oriented CodeMirror editor with tabs, save/save-as,
  per-tab state, and syntax highlighting for supported file extensions.
- **File Browser:** host filesystem navigation with open, copy, move, paste,
  and delete operations. Supported text files open in a Text Editor pane.

Workspace behavior includes:

- Drag empty space to create a pane; move and resize panes directly.
- Hold `Shift` while drawing or resizing to constrain to a square.
- Minimize, maximize, restore, dock, rename, and destroy panes.
- Use the Deskbar to list, focus, and restore open panes.
- Use `Ctrl+K`/`Cmd+K` to search commands, pane types, sessions, themes, and
  open windows.
- Cycle active panes with `Ctrl+]` and `Ctrl+[`.
- Choose a theme, default pane font size, and per-session background image.
- Persist the active pane and complete workspace document to SQLite.

## Users and named sessions

Without `-users`, Tessera creates named sessions for a synthetic `default`
user. With `-users`, the first screen presents the configured roster:

```powershell
go run ./cmd/tessera -users alice,bob,carol
```

Each user can create, rename, switch, and delete named desktop sessions.
Sessions have stable routes of the form:

```text
/users/{user}/sessions/{session}
```

Browser Back/Forward switches session routes. Each session owns its panes,
background, running commands, and terminals; theme and default font settings
are shared at the user level. Destroying a session stops only that session's
running commands and terminals, and the final session cannot be deleted.

The selected user is remembered in browser storage. This is convenience and
state separation only, not authentication or authorization.

## Desktop and platform behavior

On Windows and macOS, Tessera normally adds a notification-area icon. Its menu
can start and stop the local server, open Tessera in the default browser, or
exit cleanly. Pass `-tray=false` for server-only/headless use.

Linux releases run server-only without a tray, keeping the executable CGO-free
and avoiding GTK/AppIndicator dependencies. macOS tray builds use CGO. Windows
tray builds remain CGO-free and may use `-ldflags=-H=windowsgui` to hide the
console window.

### macOS notes

For an unsigned downloaded binary:

```bash
chmod +x /path/to/tessera
xattr -d com.apple.quarantine /path/to/tessera
```

If filesystem access prompts stall the host process, grant Full Disk Access to
the process that launches Tessera, such as Terminal, iTerm2, or the packaged
Tessera application. A future `.app` bundle and signing flow should provide a
more conventional macOS installation.

## Access from an iPad or another device

Tessera includes a web app manifest and touch-oriented workspace controls. To
reach it from an iPad on the same network, bind the server to the LAN:

```powershell
go run ./cmd/tessera -addr 0.0.0.0:7331
```

Open `http://<host-address>:7331` in Safari and use **Share > Add to Home
Screen** for standalone display. The command button provides touch access to
context actions, and the window button opens the Deskbar.

Only use LAN binding in the trusted-environment model described above. Any
device that can reach the service should currently be treated as having the
ability to operate Tessera and, through Tessera, the host machine.

## Development and testing

Frontend dependencies are bundled with esbuild and committed under
`web/vendor/`:

```powershell
npm install
npm run build:web
```

Routine checks:

```powershell
go test ./...
go vet ./...
node --check web/app.js
node --test web/text-editor-language.test.mjs
```

The Go tests cover store migrations and persistence, session lifecycle,
workspace isolation, command streaming, terminals, file operations, desktop
server control, and update behavior. Browser-visible interaction changes still
require focused browser smoke testing.

Database schema changes belong in the next contiguous numbered SQL file under
`migrations/`. Those files are embedded into the executable and applied in
order using SQLite `PRAGMA user_version`. Treat applied migration files as
immutable; append a new migration instead of editing an existing one.

## Releases and self-update

Pushing a `v*` tag runs the GitHub Actions release workflow and publishes:

- `tessera-linux-amd64`
- `tessera-windows-amd64.exe`
- `tessera-darwin-amd64`
- `tessera-darwin-arm64`

Linux and Windows builds use `CGO_ENABLED=0`. macOS Intel and ARM builds run on
native macOS runners with `CGO_ENABLED=1` for tray support.

The in-app updater checks the latest GitHub Release, downloads the asset that
matches the current operating system and architecture, swaps the executable,
and restarts Tessera. The current updater uses anonymous GitHub Releases API
access, so the repository and release assets must be reachable without private
repository credentials.
