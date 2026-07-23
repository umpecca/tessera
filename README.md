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
  delete files available to the Tessera process. Audio clients can also select
  host paths, proxy HTTP(S) audio URLs, and link live Terminal processes.
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
-audio-capture-helper string  external terminal audio capture helper
-audio-encoder string         LAME-compatible encoder override
-trusted-proxy value          trusted immediate proxy IP/CIDR (repeatable)
-rate-limit int               API requests per client per minute (default 600)
-rate-burst int               per-client API burst (default 120)
-audit-log bool               persist redacted audit events (default false)
-audit-retention-days int     enabled audit retention in days (default 30)
-max-upload-size int          maximum bytes per File Browser upload (default 1073741824)
```

For example:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -db .\tessera.sqlite3 -web .\web
go run ./cmd/tessera -users alice,bob,carol
```

## HTTP hardening and reverse proxies

Localhost and trusted-intranet access by DNS name or literal IPv4/IPv6 address
work without additional flags. Browser mutations must have either no `Origin`
(for non-browser tools) or an `Origin` exactly matching the request scheme,
host, and port. Terminal WebSocket handshakes use the same rule.

Forwarding headers are ignored unless the immediate TCP peer is explicitly
trusted. For a reverse proxy on the same host, for example:

```powershell
go run ./cmd/tessera -addr 127.0.0.1:7331 -trusted-proxy 127.0.0.1
```

`-trusted-proxy` accepts an exact IP or CIDR and may be repeated. Trusted peers
must send one unambiguous RFC `Forwarded` header or one
`X-Forwarded-For` address with optional `X-Forwarded-Host` and
`X-Forwarded-Proto`; mixed or multi-hop values are rejected. Trust only a
proxy that overwrites client-supplied forwarding headers.

The in-memory rate limiter applies to API requests and Terminal handshakes. A
negative `-rate-limit` or `-rate-burst` disables it. Audit persistence is off
by default; enable it explicitly with `-audit-log`. When enabled, records
contain request metadata for mutations and Terminal connection attempts, never
query strings, bodies, command text, file contents, cookies, or tokens. The
retention defaults to 30 days and a negative `-audit-retention-days` disables
persistence even when the toggle is on.

The console also reports each distinct client once per Tessera process using
its resolved IP address and a short, process-salted fingerprint. The fingerprint
distinguishes browsers sharing an address without printing their full
User-Agent, and it changes whenever Tessera restarts.

Security headers include a Content Security Policy, frame blocking, MIME
sniffing protection, a restrictive referrer and permissions policy, and a
short HSTS lifetime when Tessera knows the request arrived over HTTPS. HSTS is
not emitted for ordinary localhost or intranet HTTP access.

These controls do not make direct public hosting safe. Authentication,
authorization, TLS termination, filesystem roots, and command policies remain
required before exposing Tessera to untrusted networks.

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
  delete, streamed upload, and attachment download operations. Upload accepts
  multiple files, reports progress, supports drag-and-drop, and confirms before
  replacing an existing regular file. Supported text files open in a Text
  Editor pane.
- **Browser:** a sandboxed view of an HTTP(S) development server on the Tessera
  host. Enter a loopback address such as `localhost:5000`; Tessera forwards the
  page, assets, forms, fetches, redirects, and hot-reload WebSockets through its
  existing listener without exposing the development-server port. Service
  workers, strict origin assumptions, and complex authentication may require
  project-specific configuration. Open **Browse Local Port Help** from the
  command palette (`BL`) or use the network icon in a Browser pane for an
  interactive guide and launcher.
- **Audio:** a view of the host-wide shared audio station. It can play a host
  file, proxy a direct HTTP(S) audio response, or capture audio rendered by a
  linked Terminal process tree. Transport controls are shared; browser volume
  and mute are local to each listener.

### Terminal appearance

Terminal panes use the locally bundled JetBrains Mono font by default. Choose
JetBrains Mono or Fira Code under **Settings → Terminal → Font**; the per-user
choice is persisted and applies immediately to open panes. Tessera waits for
the regular and bold faces before creating a terminal so the canvas starts
with stable character-cell measurements.

Choose **Dark** or **Light** under **Settings → Terminal → Colors**. Both modes
use the conventional xterm RGB values for indexed colors 0–15 and leave
256-color and 24-bit application output unmodified; only the neutral default
foreground, background, cursor, and selection colors change. Terminal colors
are independent of Tessera's workspace theme. ANSI defines the indexed color
roles but does not assign exact RGB values to them.

Solid Unicode block elements are drawn as pixel-aligned cell geometry instead
of font glyphs. This keeps fractional blocks and quadrant art joined without
the seams that browser font rasterization can introduce. Shade characters
remain font-rendered.

Copy selected terminal text with `Cmd+C` on macOS or `Ctrl+Shift+C` elsewhere.
Paste with `Cmd+V`, `Ctrl+Shift+V`, or `Shift+Insert`. Unmodified `Ctrl+C`
continues to send an interrupt to the terminal process.

## Shared audio station

The Audio pane is available from the window-type menu, workspace menu, and
command palette (`NA`). Any connected client can replace the source or control
Play, Pause, Stop, and file seeking; the latest valid command wins. The source
and file position survive a restart, but Tessera always restarts paused.

File sources must be absolute host paths. URL sources must be direct HTTP(S)
audio responses; playlists, HLS/DASH, metadata extraction, and artwork are not
handled. Terminal sources work only when the selected Terminal pane or one of
its descendant processes actually renders audio. A controller-only CLI that
talks to a player outside that process tree will be silent. Protected/DRM audio
may also be unavailable, and Tessera does not try to bypass that boundary.

Terminal capture requires both the bundled LAME companion and a separately
installed platform capture helper. Tessera resolves the helper from
`-audio-capture-helper`, beside the Tessera executable, then from `PATH`. The
helper executable is named `tessera-audio-capture` (with the usual `.exe` on
Windows) and must implement:

```text
tessera-audio-capture capture --pid <pid> --include-tree \
  --format s16le --sample-rate 48000 --channels 2
```

Its stdout is raw interleaved 48 kHz stereo signed 16-bit little-endian PCM.
Its stderr is NDJSON containing `ready`, `warning`, and `error` events. Windows
helpers require process-loopback support (Windows 10 build 20348 or later),
Linux helpers require PipeWire, and macOS helpers require ScreenCaptureKit audio
permission. FreeBSD/OpenBSD retain file and URL playback but report Terminal
capture as unsupported. The optional helper is not installed by self-update.

### LAME encoder companion

For a manual installation, place the encoder for the host platform beside the
Tessera executable. Keep the release asset name unchanged so Tessera can find
it automatically:

| Platform | Tessera executable | Encoder companion |
| --- | --- | --- |
| Windows x64 | `tessera-windows-amd64.exe` | `tessera-lame-windows-amd64.exe` |
| macOS Intel | `tessera-darwin-amd64` | `tessera-lame-darwin-amd64` |
| macOS Apple silicon | `tessera-darwin-arm64` | `tessera-lame-darwin-arm64` |

On macOS, mark both downloaded files executable:

```bash
chmod +x tessera-darwin-* tessera-lame-darwin-*
```

The encoder may instead be stored elsewhere and selected explicitly:

```powershell
# Windows
.\tessera-windows-amd64.exe -audio-encoder C:\path\to\lame.exe
```

```bash
# macOS
./tessera-darwin-arm64 -audio-encoder /path/to/lame
```

Without an override, Tessera checks for the exact platform asset name beside
its executable, then `tessera-lame` and `lame` beside it and on `PATH`. The
in-app updater installs the matching platform companion automatically. The
encoder converts captured PCM to MP3; it does not replace the separately
installed capture helper described above.

Workspace behavior includes:

- Drag empty space to create a pane; move and resize panes directly.
- Hold `Shift` while drawing or resizing to constrain to a square.
- Minimize, maximize, restore, dock, rename, and destroy panes.
- Use the Deskbar to list, focus, and restore open panes.
- Use `Ctrl+K`/`Cmd+K` to search commands, pane types, sessions, themes, and
  open windows.
- Cycle active panes with `Ctrl+]` and `Ctrl+[`.
- Choose a theme, default pane font size, per-session background image, and
  independent Terminal and editor wheel-scroll speeds.
- Persist the active pane and complete workspace document to SQLite.
- Reject stale whole-workspace saves from older tabs or reconnecting computers;
  autosave pauses and offers to reload when a newer revision already exists.
- Detect loss of the server connection and present Reconnect and Refresh Page
  actions. Recovery is confirmed before the current session route is reloaded.
- Reconnect an unexpectedly closed Terminal WebSocket automatically without
  treating that pane transport failure as a server outage.

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
background, running commands, and terminals; theme, default font, terminal
color mode, and terminal `TERM` settings are shared at the user level. The
`TERM` value applies when a new terminal process is created; existing
terminals keep their original environment. Destroying a session stops only
that session's running commands and terminals, and the final session cannot be
deleted.

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
node --test web/server-connection.test.mjs
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

### Building all encoder artifacts in GitHub Actions

The release workflow builds the Windows x64, macOS Intel, and macOS Apple
silicon encoders on their matching GitHub-hosted runners. Nothing from the
Windows or macOS toolchain needs to be installed on the computer that pushes
the repository. Ensure Actions are enabled for the repository, then either:

- Push `main` to build the artifacts and download them from that workflow run.
- Push a `v*` tag to build them and attach them to a GitHub Release.

For example, after choosing the next version:

```powershell
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

The Windows job provisions an MSYS2 MINGW64 environment, builds the pinned
LAME 3.100 source with the repository's MinGW compatibility patch, and verifies
the resulting `.exe`. The two macOS jobs compile natively on Intel and Apple
silicon runners. Their outputs are named exactly as listed below.

### Building an encoder locally

GitHub Actions is the simplest way to obtain every architecture. To reproduce
one build locally, use a machine with that target architecture.

On Windows x64, install [MSYS2](https://www.msys2.org/), open its **MINGW64**
shell, and install the packages used by CI:

```bash
pacman -Syu
pacman -S --needed autoconf automake libtool make patch tar mingw-w64-x86_64-gcc
```

If the update asks you to close the shell, reopen **MINGW64** and run the second
command again. Then follow the `encoder-windows` commands in the
[release workflow](.github/workflows/release.yml). They download the pinned
source, apply the
[MinGW compatibility patch](.github/patches/lame-3.100-mingw-langinfo.patch),
build it, and copy the result to `tessera-lame-windows-amd64.exe`. Use the
MINGW64 shell—not a plain MSYS shell—so the result is a native Windows
executable.

On macOS, install Apple's command-line developer tools and run the commands
from the matching encoder job in the same workflow:

```bash
xcode-select --install
```

Build on an Intel Mac for `tessera-lame-darwin-amd64`, or on an Apple silicon
Mac for `tessera-lame-darwin-arm64`. Cross-compiling is not required by the
release process because GitHub Actions uses native runners for both.

Pushing a `v*` tag runs the GitHub Actions release workflow and publishes:

- `tessera-freebsd-amd64`
- `tessera-linux-amd64`
- `tessera-openbsd-amd64`
- `tessera-windows-amd64.exe`
- `tessera-darwin-amd64`
- `tessera-darwin-arm64`
- `tessera-lame-linux-amd64`
- `tessera-lame-windows-amd64.exe`
- `tessera-lame-darwin-amd64`
- `tessera-lame-darwin-arm64`
- `lame-3.100.tar.gz` and `LICENSE.LAME.txt`

FreeBSD, Linux, OpenBSD, and Windows builds use `CGO_ENABLED=0`. The BSD and
Linux builds run server-only without tray support. macOS Intel and ARM builds
run on native macOS runners with `CGO_ENABLED=1` for tray support.

The in-app updater checks the latest GitHub Release, downloads the Tessera and
LAME assets matching the current operating system and architecture, installs
them as one rollback-capable transaction, and restarts Tessera without requiring
a service manager or watchdog. After the old server releases its listener,
sessions, audio processes, and database, every desktop platform starts the
replacement as an independent process. The old process remains alive until the
replacement confirms that its server started; startup failures are returned to
the old process and logged instead of treating process creation as a successful
restart. A new Tessera binary installed by a legacy updater can fetch its
exact-version LAME companion on the first Terminal capture attempt. LAME 3.100
is distributed under the LGPL; the release includes its license and
corresponding pinned source archive. Anonymous GitHub Releases API access is
used, so release assets must be reachable without private repository
credentials.
