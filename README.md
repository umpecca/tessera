# Tessera

Tessera is a local-first, text-first computer workspace. A Go host serves an
embedded browser application, persists desktops in SQLite, and provides local
shell, terminal, and filesystem capabilities. The interface uses movable,
resizable panes with BeOS-inspired window chrome and a Deskbar.

See [ARCHITECTURE.md](ARCHITECTURE.md) for component boundaries, data flow,
deployment details, and the security roadmap.

Start with [Run](#run) or the [Ubuntu service installer](#install-as-an-ubuntu-service).
The [workspace guide](#workspace-model) covers pane types and terminal behavior;
[development and testing](#development-and-testing) covers builds and checks.
See [Known issues](#known-issues) for the unresolved terminal graphics limitations
and [CHANGELOG.md](CHANGELOG.md) for recent changes.

Terminal panes support Sixel images and restore retained text and images from
the running host when a browser reconnects. Right-click a terminal to choose an
image-memory budget, toggle discarded-image markers, or clear images while
keeping text. See [terminal core documentation](docs/terminal-core.md)
for the pinned source build, protocol, resource limits, and restoration guarantees.

Right-click a terminal or its window menu and choose **Terminal colors** to use
**Dark**, **Light**, or **Use default** for that pane. The choice is saved with
the session. **Use default** follows the user's Terminal colors setting;
explicit choices remain independent when that default changes. Changing colors
keeps the running shell and restores its retained output.

Terminal wheel and trackpad scrolling moves smoothly at every Terminal wheel
speed in Settings. Rapid gestures retain their distance and direction changes
respond promptly. Scrolling into history keeps that view while output arrives;
typing resumes following live output. System reduced-motion preferences disable
the scroll animation.

Terminal windows follow application titles sent with OSC 0 or OSC 2. The title
appears in the window tab and window lists and recovers when a terminal view
reconnects. Apps that do not send titles keep the current name. Manual renaming
remains available; the next application title can replace it. Title updates
pause while that window's title editor is open. Empty titles are ignored.
Programs can save the title and restore it later (`CSI 22 ; 0 t` and
`CSI 23 ; 0 t`, as Vim does with `set title`); when that restores no title,
or `reset` clears it, the window gets back the name it had before programs
titled it, if this page saw that name.

A progress report (OSC 9;4, `ESC ] 9 ; 4 ; state ; percent BEL`) shows as a
thin bar along the window's title bar: state 1 with a percentage, 2 error
(red), 3 busy without a percentage (a moving segment), 4 paused (amber), 0 to
remove it. It updates while the window is minimized or covered, and goes 15
seconds after the last report, as in Ghostty.

A terminal's working directory follows its shell when the shell reports it
with OSC 7 (`file://host/path`). The pane's directory field shows it, new
terminals opened from that pane start there, and a shell restarted after the
host restarts starts there; a directory that no longer exists falls back to
the host default. Only reports naming the Tessera host (or `localhost`) count,
so a shell inside `ssh` does not move the pane to a path on another machine.
Tessera's shell integration (below) has zsh and bash report it; other shells
need to send it themselves.

**Find in a terminal's scrollback** with `Cmd+F` (`Ctrl+Shift+F` off an Apple
keyboard, so `Ctrl+F` still reaches the shell), **Find…** in the terminal's
context menu, or **Find in Terminal** in the command palette. A bar opens in
the window's top-right corner and searches as you type, ignoring case for
ASCII letters and finding text that wraps across rows; a one-line selection
becomes the text to find. Matches are highlighted yellow and the selected one
orange. The newest is selected first; `Enter` (or `Cmd+G`, `F3`) moves to the
next older one and `Shift+Enter` (`Cmd+Shift+G`, `Shift+F3`) to the next
newer, scrolling it into view, and the count reads "3 of 12" from the oldest.
Output that arrives while the bar is open is searched too, and the selected
match stays put. A full-screen program's screen (Vim, less) is searched while
it shows. `Escape` closes the bar and puts the keyboard back in the terminal.

Shells that mark their prompts with OSC 133 get two more things. `Cmd+Up` and
`Cmd+Down` (`Ctrl+Shift+Page Up`/`Page Down` off an Apple keyboard) scroll the
previous or next prompt to the top of the pane. **Copy Command Output** in the
terminal's context menu selects and copies what the command under the pointer
printed, and **Copy Last Command Output** in the command palette does the same
for the latest command.

**Shell integration.** Tessera starts zsh, and bash 4.4 or later, set up to
send these prompt marks and the OSC 7 directory reports, so the features above
and command finished notices (below) work without editing any startup file.
zsh starts with `ZDOTDIR` pointing at a Tessera `.zshenv`, which puts
`ZDOTDIR` back, reads yours, and adds the hooks, so the rest of startup and
any zsh you start later use your own files as usual; bash starts with
`--rcfile` pointing at a file that reads `~/.bashrc` first. The scripts are
written to Tessera's folder in your user cache folder. A command started with
a space, when the shell keeps such commands out of history, isn't named in
notices. Turn it off with **Settings → Terminal → Shell integration**
(new terminals), or set `TESSERA_SHELL_INTEGRATION=0` in your shell's
startup file. If you added the hooks from earlier versions of this README to
`~/.zshrc`, they are no longer needed, though leaving them does no harm.
Other shells (fish, the macOS `/bin/bash` 3.2) start as before, and can send
the marks themselves.

Underlines can be double (`ESC [ 21 m` or `ESC [ 4:2 m`), curly (`4:3`),
dotted (`4:4`) or dashed (`4:5`), and have their own colour (`ESC [ 58 m`,
as `58:2::r:g:b` or `58:5:n`; `59` goes back to the text colour). Neovim uses
red curly underlines for errors and spelling, and some prompts and editors
use the others.

Programs can recolour a terminal while it runs, as base16-shell, vim and fzf
themes do: OSC 4 sets entries of the 256-colour palette and OSC 104 resets
them; OSC 10, 11 and 12 set the default foreground, background and cursor,
and OSC 17 and 19 the selection's background and text; OSC 110–119 reset
those. A `?` in place of a colour asks for the current one, answered in
xterm's `rgb:rrrr/gggg/bbbb` form. Colours a program sets stay through
reconnects and switching the pane between light and dark; a reset, OSC 110
and the like, or `reset` give back the pane's own.

Programs that turn on the Kitty keyboard protocol (`CSI > flags u`), such as
Neovim, Helix and fish, get keys that ordinary encoding can't
tell apart: Escape from Alt+key, Tab from Ctrl+I, Enter and Backspace with
Shift or Ctrl, and, if they ask, key releases and repeats. Tessera answers
the protocol's query (`CSI ? u`) and encodes keys with Ghostty's encoder while
it is on, and as before once the program turns it off. On an Apple keyboard,
Command still never reaches the program, except that Command+Left and
Command+Right are Home and End, and Option is Alt, as without the protocol.
Tessera's own shortcuts (window switching, the palette, copy and paste, prompt
jumps) keep their keys.

Programs can ask which modes are on (DECRQM, `CSI ? mode $ p`) and which
terminal this is (XTVERSION, `CSI > q`, answered `Tessera` and the version).
Modes Tessera tracks but doesn't act on, such as the mouse report formats
other than SGR, are answered as unrecognised so programs don't rely on them.
Programs can also ask for terminfo capabilities directly (XTGETTCAP,
`DCS + q`), as Neovim does to find true colour and OSC 52 copying; the
answers are Ghostty's, with the name (`TN`) being the configured `TERM`. Settings queries (DECRQSS,
`DCS $ q`) report the current colours and attributes, cursor style and
margins. Programs that enable in-band size reports (mode 2048) are told the
pane's size in cells and pixels (`CSI 48 ; rows ; cols ; height ; width t`)
when they turn it on and after each resize.

Programs that bracket a redraw with synchronized output (mode 2026), as
Neovim and tmux can, have it shown whole: the browser doesn't paint
while the mode is on, however the redraw is split on its way over the
network, and paints once the program ends it. As in Ghostty, a redraw the
program never ends (if it crashes mid-redraw, say) is ended after a second,
and a resize ends it.

Programs that follow light and dark themes can ask which the pane uses
(`CSI ? 996 n`) and, with mode 2031 on, are told when it changes, which
recent Neovim uses to set its background. Programs that enable focus reports
(mode 1004), as Vim, Neovim and tmux can (for example to reload changed
files), are told when the pane gains and loses focus: it is focused while it is the
active window and the page has the keyboard, in any browser showing it.

A terminal's bell (BEL), and notifications programs send with OSC 9 (`ESC ]
9 ; text BEL`) or OSC 777 (`ESC ] 777 ; notify ; title ; text BEL`), mark a
window you aren't looking at with a dot on its icon and `[bell]` or
`[notification]` in window lists until you show it; this works whether or
not the window's output is paused. Notifications also appear in the page's
corner, and clicking one opens the window. **Settings → Terminal → System
notifications** also shows them as system notifications while Tessera is in
the background, where the browser allows it (Safari on iPad only for a Home
Screen web app). A notification sent while no browser was connected is shown
on the next one to connect. Bells in the window you are using do nothing.

A command that runs for 5 seconds or more and finishes in a window you aren't
looking at gets a notice too, as in Ghostty: "`make all` · Failed with exit
status 2 after 4 min 12 s", with `[finished]` or `[failed]` in window lists.
It needs the shell's prompt marks, which shell integration provides; turn it
off with **Settings → Terminal → Command finished notices**. System
notifications include these.

Programs can set the mouse pointer's shape over the terminal with OSC 22, by
CSS cursor name (`pointer`, `crosshair`, `grab`, ...) or X cursor name
(`hand`, `xterm`, ...). A link under the pointer still shows the hand; a full
reset (`reset`) puts back the text pointer.

Terminal apps can also send short WAV/MP3 clips directly to enabled browsers,
or stream files/stdin incrementally as Opus using FFmpeg, with selectable
bitrate and buffering. Both mix with local per-terminal mute. See [terminal audio](docs/terminal-audio.md)
for the private escape-sequence protocol. The audio and file CLI programs are
maintained and released in an independent repository.

## Security and trusted-environment status

Tessera is currently intended for use by one operator or a small group in a
trusted environment. [Sign-in](#sign-in) is available but off by default, and
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
- Optional [Local HTTPS](#local-https-for-ipados) provides TLS using Tessera's
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

The installer detects the host architecture, downloads the matching binary
from the latest GitHub Release, and installs it at `/usr/local/bin/tessera`.
It runs the service as the non-root account that invoked `sudo`, uses that
account's home directory as the service working directory, stores the SQLite
database under `/var/lib/tessera`, and enables `tessera.service` at startup.
Run the installer from your normal account with `sudo`; running it directly
from a root login is rejected because there is no invoking user to select. It
prompts for a listen address: press Enter to use the safe `127.0.0.1` default,
or enter `0.0.0.0` to listen on every network interface. A non-interactive run
uses `127.0.0.1`.

Running the installer again downloads the latest Tessera executable, prompts
for the listen address when interactive, and restarts the service. Install the
optional terminal audio CLI from its independent repository; see
[terminal audio](docs/terminal-audio.md).

With the default selection, Tessera listens only on `127.0.0.1:7331`. From the
Ubuntu host, open <http://127.0.0.1:7331>. If Ubuntu is running in a VM and you
need access from the macOS host, use SSH port forwarding instead of exposing
Tessera directly:

```bash
ssh -L 7331:127.0.0.1:7331 your-user@your-ubuntu-vm
```

Choosing `0.0.0.0` makes Tessera reachable through the Ubuntu host's network
addresses. Only choose it on a trusted network, and restrict port 7331 with the
host or network firewall as appropriate.

Useful service commands:

```bash
systemctl status tessera.service
journalctl -u tessera.service -f
sudo systemctl restart tessera.service
```

Tessera terminals and file operations have the same home-directory access,
supplementary groups, and existing `sudo` permissions as the account that ran
the installer. Anyone who can access Tessera can therefore act with that
account's authority and may be able to obtain root access through `sudo`.
Keep Tessera restricted to trusted users and networks. Upgrading an older
installation transfers `/var/lib/tessera` to the invoking user but does not
automatically delete the old `tessera` system account.

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
authorization, filesystem roots, and command policies remain
required before exposing Tessera to untrusted networks.

## Workspace model

Tessera presents a full-window desktop where panes can overlap and retain
their geometry, z-order, title, working directory, font size, and content.

Draw a new window by left-dragging empty desktop space, or hold the middle
mouse button and drag over any pane, including Browser content. Release to
choose the window type. A simple middle click creates nothing; Escape cancels
the outline. Left clicks inside existing panes keep their normal behavior.

Current pane types:

- **Terminal:** a persistent PTY terminal using ConPTY on Windows and a Unix
  PTY on macOS/Linux. Terminal sessions retain bounded scrollback while the
  server process remains alive.
- **Browser:** a sandboxed view of an HTTP(S) development server on the Tessera
  host. Enter a loopback address such as `localhost:5000`; Tessera forwards the
  page, assets, forms, fetches, redirects, and hot-reload WebSockets through its
  existing listener without exposing the development-server port. Service
  workers, strict origin assumptions, and complex authentication may require
  project-specific configuration. Open **Browse Local Port Help** from the
  command palette (`BL`) or use the network icon in a Browser pane for an
  interactive guide and launcher.
- **VNC:** an interactive remote desktop powered by the bundled noVNC client.
  Enter a DNS name, IPv4 address, or bracketed IPv6 address with an optional
  port, then choose **Connect**. The target and display preferences persist,
  but credentials remain only in the current browser page and connections are
  never restored automatically.
### Browser pane limits

A Browser pane shows the development server in a sandboxed frame without
`allow-same-origin`, so the page has an opaque origin (`window.origin` is
`"null"`; `location.origin` still reports Tessera's address). For the page:

- `localStorage`, `sessionStorage`, IndexedDB and `document.cookie` throw.
- `postMessage(message, window.origin)` throws because `"null"` isn't a valid
  target; use `"*"` and check `event.source` when receiving.
- It can't read a child frame's `contentDocument`, even one from the same site.
- Cookies are not kept: Tessera strips `Cookie` and `Set-Cookie` in both
  directions. Carry state in the URL or a request header instead.
- HTML rewriting covers only `src`, `href`, `action` and `poster` values that
  start with `/`. `data-*` attributes match only when the name ends in `href`
  or `src` (for example `data-href`); `srcset` and URLs assembled in
  JavaScript are not rewritten, except through the patched `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource` and `window.open`.
- Link clicks and form submits stay inside the proxy. A root-relative
  navigation from script, such as `location.replace("/")`, briefly loads a
  Tessera page that sends the frame back through the proxy. If that page
  stays up, it names the path the site tried to open.

### VNC connections

VNC panes connect from the Tessera host directly to any requested TCP address;
port 5900 is used when none is given. Browser-to-Tessera traffic uses the
page's `ws` or `wss` transport, while the Tessera-to-VNC leg is ordinary TCP
unless the negotiated VNC security scheme protects it. SSH tunneling, VNC file
transfer, audio, power controls, automatic reconnect, remote-resolution resize,
and saved credentials are not included.

The VNC bridge can reach public, private, loopback, and host-local services and
therefore acts as a general TCP capability for anyone who can access Tessera.
Run Tessera only for trusted users on trusted networks. The same-origin checks
and short-lived one-use connection tokens are defense in depth, not user
authentication or a destination firewall.

Use **Fit** to scale the remote desktop into its window or **1:1** for native
pixels with scrolling. **View only** suppresses remote input. Clipboard text is
never moved automatically: the up-arrow sends local clipboard text and the
down-arrow copies the most recently received remote text. A visible text field
is offered when the browser refuses clipboard access.

### Terminal output backlog

Under **Settings → Advanced → Performance**, **Terminal output backlog** limits
output waiting to be processed in each terminal. **Auto** follows the server's
retained-output window (normally 4 MiB); **8**, **16**, and **32 MiB** allow larger
bursts. The choice is saved in this browser and applies to open terminals
immediately. Exceeding the limit catches up from a fresh server snapshot while
the shell keeps running. This budget is separate from scrollback and images.

Minimized terminals, terminals fully covered by another window, and background
browser tabs stop processing output in the browser. Their shells keep running
on the server. Partially overlapping windows continue processing and painting
their terminal output; only complete coverage pauses a pane. Revealing a
terminal catches up through a small ordered replay,
or restores its latest screen and retained scrollback from a snapshot for a
larger gap, then resumes live output. Replay is capped at 64 KiB and 128 events.
Idle terminals keep their existing view. Hidden terminals pause server delivery
and retain their connections for shell-exit notices without keeping an output
backlog. Initially hidden panes start without transferring a snapshot. Frames
already in flight when a pane hides are discarded by the browser.

Visible terminals share a parsing turn of 64 KiB of output or roughly 5 ms
of work. The active terminal gets three complete events per visit and other
busy panes get one, keeping background builds moving while prioritizing the
terminal you are using. This leaves time for typing, scrolling, and window
controls during parallel builds. Complete stream events stay in order; an
individual event or snapshot import can exceed the time budget.

Painting also shares roughly 6 ms per animation frame. The active terminal
normally paints first, while other ready panes rotate across frames. If one
active paint uses the whole budget, a waiting background pane gets the first
slot next frame. Deferred panes keep their redraw requests and paint the latest
state. An individual terminal paint can exceed the budget.

Small paints read and decode only the native rows they need. Full paints read
and decode the live terminal viewport once, sharing it across the rows being
drawn. Later frames read fresh output; history rows
retain their separate reads. Idle and history-only paints skip the live read.

Each browser terminal also reuses a lazy WASM input buffer across output events,
reset, and snapshot restore. It grows up to 64 KiB; larger events use temporary
space. Closing the terminal releases the retained allocation.

Sixel images allow ordinary text updates and cursor blinking to repaint only
changed rows, including while images remain visible. Image fragments are
composited only where text was repainted, preserving transparency, selection,
and cursor layering. When the last visible image disappears, one full redraw
clears its old pixels. Scrolling, resizing, image changes, visible scrollbar
updates retain full redraws. At fractional display scaling, cell backgrounds,
images, selection, cursors, and damage clips share rounded physical pixel edges,
and decoration strokes use whole-pixel thickness. This keeps partial paints
consistent with full redraws at 125%/150% and other fractional scales. Canvas
dimensions use the same rounding, including odd-sized terminal grids.

If the browser reports a canvas context loss, both terminal renderers keep
accepting output and repaint retained text and images when graphics recover.
This recovery preserves the running shell and works even if no fresh output
arrives after restoration. Intermittent graphics stalls and silent canvas
corruption remain [known issues](docs/known-issues.md).

### Older Mac performance

Choose **Older Mac** under **Settings → Performance → Profile** to cap terminal
canvases at 1× device resolution, use a steady active cursor, disable terminal
smooth scrolling, and stop decorative status animations. On a 2× Retina
display, the terminal paints one quarter as many canvas pixels while preserving
the same rows, columns, font size, and terminal contents. The setting is stored
in that browser, applies immediately to its open terminals, and does not cap a
newer computer signed in as the same Tessera user. Choose **Standard** to
restore native display resolution and animation.

Open **Settings → Diagnostics** to see the clipboard APIs
available to the current page, Firefox extension connection, effective
terminal rendering scale, and Tessera server status. **Copy diagnostics**
creates a troubleshooting summary without workspace, session, host, or
clipboard contents.

Settings opens with everyday font, theme, terminal appearance, scrolling, and
background preferences. **Advanced** holds TERM, renderer experiments, and
output/paint coalescing. **Advanced** and **Diagnostics** start collapsed;
live diagnostic checks and rendering measurements run only while Diagnostics
is expanded. Tab and Shift+Tab stay within visible Settings controls, Escape
closes the dialog, and closing returns focus to its invoking control or pane.

New browsers use the **Standard** performance profile, **Experimental** terminal
renderer, **Paint coalescing On**, and **Server output coalescing Off**. These
preferences are saved in the current browser; existing selections take priority
over the defaults. The renderer and coalescing controls are under **Advanced**.

**Experimental** accelerates ordinary text rows while retaining the established
drawing paths for complex characters, styling, selection, and links. **Stable**
uses the classic renderer. Both support Sixel images and canvas recovery;
changing renderers is not a confirmed workaround for Windows graphics stalls.

Choose **Operator** under **Settings → Theme → Current** for charcoal surfaces,
mint accents, a softly lit active pane, and dotted title-bar grips. Windows stay
movable and resizable, with 32px desktop title bars (48px for touch), ordinary
titles for new panes, and minimize, maximize/restore, and close controls. The
title bar, border, and shadow disappear when maximized, matching OLED Terminal;
use **Alt+F10** or **Maximize / restore** in the command palette to restore it.
Double-left-click a window title bar to toggle maximize/restore.
Closing a live terminal confirms ending its shell. Existing titles and terminal
color preferences are preserved.
**Wobbly windows** in the same section adds gentle whole-window tilt and stretch
while dragging. It is saved per browser, does not change window or terminal
dimensions, and is disabled by reduced motion or **Older Mac** mode.

### Terminal appearance

Use `Ctrl+Plus`/`Cmd+Plus` and `Ctrl+Minus`/`Cmd+Minus` to adjust the active
pane's text size. A brief indicator shows the size as a percentage of the
configured default; `Ctrl+0`/`Cmd+0` restores that default and shows 100%.

Terminal panes use the locally bundled JetBrains Mono font by default. Choose
JetBrains Mono or Fira Code under **Settings → Terminal → Font**; the per-user
choice is persisted and applies immediately to open panes. Tessera waits for
the regular and bold faces before creating a terminal so the canvas starts
with stable character-cell measurements. A bundled Noto Sans Symbols 2 face is
used only when the selected monospace font lacks a symbol, avoiding platform
fallback metrics that can overlap terminal cells in legacy Firefox/macOS.

Choose **Tight** (the default) or **Comfortable** under **Settings → Terminal →
Row spacing**. Tight fits the font's full height without extra padding;
Comfortable adds a pixel above and below each row. The choice saves per user
and immediately refits open terminals.

Choose **Dark** or **Light** under **Settings → Terminal → Colors**. Both modes
use the conventional xterm RGB values for indexed colors 0–15 and leave
256-color and 24-bit application output unmodified; only the neutral default
foreground, background, cursor, and selection colors change. Terminal colors
are independent of Tessera's workspace theme. ANSI defines the indexed color
roles but does not assign exact RGB values to them.

### Typing prediction

Over a slow connection, such as a VPN to a distant host, each typed character
normally appears only after a round trip to the server. **Settings → Terminal
→ Typing prediction** draws printable characters as soon as you type them,
in the manner of mosh. They look like ordinary text, since a quick echo
replaces them within a frame or two; they are lightly underlined only while
the echo time is above 80 ms, or after a wrong or slow guess until enough
later echoes come back quickly. **Auto** (the default) turns on once the measured echo time exceeds
20 ms, so a fast local connection looks unchanged; **Always** and **Off** are
also available. The choice is saved in this browser.

Predictions never change the terminal's contents. After Enter, arrow keys, a
paste, or any wrong guess, nothing is predicted again until the server echoes
a character, so programs that do not echo, such as password prompts, never
show typed text. Backspace removes a character that is still only predicted,
and erases already-echoed text when the cursor is at the end of the line (not
mid-line, where the shell shifts the rest of the line). Only single-width
ASCII characters are predicted, and never past the end of the line. Settings
→ Diagnostics shows whether prediction is drawing and the echo time it
measured.

Solid Unicode block elements are drawn as pixel-aligned cell geometry instead
of font glyphs. This keeps fractional blocks and quadrant art joined without
the seams that browser font rasterization can introduce. Shade characters
remain font-rendered.

Copy selected terminal text with `Cmd+C` on macOS or `Ctrl+Shift+C` elsewhere.
Paste with the platform's own paste key — `Cmd+V` on macOS, `Ctrl+V` elsewhere —
or with `Ctrl+Shift+V` or `Shift+Insert`. Unmodified `Ctrl+C` continues to send
an interrupt to the terminal process.

These are the terminal's own clipboard, not the running program's. A full-screen
program keeps its own selection and its own copy and paste keys — `^C` and `^V`
in Fresh, for instance — and those keys reach it: on macOS `Ctrl+V` arrives as
`^V` rather than being taken for a paste, since `Command` is the paste key
there. `Command` with a letter is a menu accelerator and is not sent to the
terminal at all, so `Cmd+S` in a full-screen editor does nothing instead of
typing an `s`.

On macOS and iPadOS, `Cmd+Left` and `Cmd+Right` send Home and End, for
keyboards without those keys such as the iPad Magic Keyboard, where
`Globe+Left` and `Globe+Right` do the same. bash handles
them as it is. zsh only does if they are bound; add this to `~/.zshrc` if
Home and End do nothing at the prompt:

```zsh
bindkey '^[[H' beginning-of-line '^[[F' end-of-line
```

A mouse-aware program owns unmodified dragging, so dragging inside one moves
that program's cursor rather than selecting terminal text. Hold `Shift` while
dragging to select on the terminal's own layer, then copy as usual. `Cmd`-drag
also works on macOS; `Ctrl`-drag works on other platforms. A copy that finds
nothing selected reports "Nothing to copy" in the workspace status rather than
doing nothing silently.

Open terminal hyperlinks with `Cmd`-click on macOS or `Ctrl`-click elsewhere.
This covers both addresses in the text and OSC 8 hyperlinks (`ls --hyperlink`,
for example), but only `http` and `https` ones open. A link to `localhost` or
`127.0.0.1`, printed or OSC 8, opens in a Browser window, which reaches the
host's ports, rather than a new tab. An address wrapped onto the next row opens
whole from either row. Hover over an OSC 8 link to see its address along the
bottom of the pane, since its text can say anything.
On macOS, `Ctrl`-click opens the terminal context menu and preserves selected
text for Copy. Interrupted selection drags stop when focus is lost or the
mouse is released, and selection changes redraw even while output is idle.

The platform paste key is handled by the browser's paste event, so it works
without clipboard permission and on insecure origins. Tessera takes that event
itself and pastes through the terminal, so an application that asked for
bracketed paste receives the text as one paste rather than as typing — which is
what lets a TUI editor undo a paste in a single step. `Ctrl+Shift+V` and
`Shift+Insert` read the clipboard directly instead, which some browsers refuse;
when that happens Tessera pastes its own last copy and says so in the workspace
status rather than pasting silently.

Pasting an image — a screenshot copied on an iPad, say — works too, with the
same paste key. A terminal can only carry text, and programs such as opencode
paste images by reading the host's clipboard when they receive `Ctrl+V`. So
Tessera sends the image to the server, which puts it on the clipboard of the
desktop session it runs in, then sends the program `Ctrl+V` (encoded with the
Kitty keyboard protocol when the program asked for it). The image never
touches the disk. A paste that has text as well pastes the text. The server
writes the macOS pasteboard or the Windows clipboard directly, and on Linux
uses `wl-copy` (Wayland) or `xclip` (X11). It needs Tessera running in your
logged-in desktop session, such as from the menu bar or tray app: a background
service, a process started over SSH, or a host with no display has no
clipboard for programs to read. Settings → Diagnostics → Enhanced copy/paste
says whether it is working, and why not when it isn't.

**Save Clipboard to File...** in the command palette saves what is on the
clipboard to a folder on the host: text as `clipboard.txt`, an image as
`clipboard.png`, each name editable. The browser's clipboard API offers only
text and images, so files copied in Finder or the Files app are added by
pressing the paste key inside the dialog, or by dropping them on it. Buttons
jump to Home, Temp (the host account's temporary folder), Current (the active
terminal's folder, as shell integration reports it) and the usual Desktop,
Documents and Downloads; the list below moves through folders. A name that
exists already is replaced only after you agree. **Delete Last Clipboard
Save...** then removes the files that save wrote, after asking. It deletes
only files Tessera saved this way and that are unchanged since, and the
server forgets them when it restarts.

A full-screen terminal program has no browser selection to copy, so it reaches
the clipboard with OSC 52 (`ESC ] 52 ; c ; <base64> BEL`). Tessera takes those
sequences out of the terminal stream and writes the text to the system
clipboard, which is what makes a copy inside an editor such as Fresh, Vim, or
Helix available to other applications on the machine running the browser. A
browser that refuses the write leaves the text on Tessera's own Paste and
reports "Clipboard blocked". OSC 52 clipboard *reads* are ignored and never
answered: replying would let any program running in a Terminal pane read the
operator's clipboard.

## Terminal audio

Terminal applications can send short WAV/MP3 clips or live Opus streams through
the private OSC protocol. Enable playback from a terminal's context menu and
mute individual terminals locally. Audio producers send embedded clip bytes or
Opus packets; CLI tools are maintained separately. See
[terminal audio](docs/terminal-audio.md) for controls and protocol
examples.

The standalone Audio pane, shared file/URL transport, process capture, and
bundled LAME encoder have been retired. On upgrade, migration 044 removes saved
Audio panes and station state, preserving all other panes and workspace settings.
Old capture/encoder flags are no longer accepted. Previously installed encoder
files are left alone.

Workspace behavior includes:

- Drag empty space to create a pane; move and resize panes directly.
- Hold `Shift` while drawing or resizing to constrain to a square.
- Minimize, maximize, restore, dock, rename, and destroy panes.
- Use the Deskbar to list, focus, and restore open panes.
- Use `Ctrl+K`/`Cmd+K` to search commands, pane types, sessions, themes, and
  open windows. Exact shortcut codes appear first. Use ↑/↓ to select a result
  and Enter to run it; typing never runs a palette command automatically.
  Search aliases include `preferences` for Settings, `rename` for Set Window
  Title, and `close` for Destroy Window.
- Open the experimental **Command Wheel** with `Ctrl+;`/`Cmd+;`, or from the
  workspace menu. Hover or type a first key to reveal valid second keys, then type or
  click the next key to run its command (for example, `N` → `N` creates a
  terminal). Settings opens directly with `S` in the wheel and `S` then Enter
  in the palette.
  **Tessera Sessions** uses `T` → `S` in the wheel and `TS` in the palette.
  Backspace goes back, Escape closes, and **Search all commands**
  opens the existing palette. Clicking or typing a group keeps it selected.
  Dark radial wedges surround a context hub, with next keys in an outer arc.
- Run **Screensaver** from the command palette to fill the screen with a
  slowly shifting mosaic, Matrix-style digital rain and a tile clock. Any
  key, click, tap or mouse movement returns to the workspace. It doesn't
  lock anything.
- Cycle active panes with `Ctrl+]` and `Ctrl+[`.
- Move the active window earlier/later with `Ctrl+Shift+Up`/`Ctrl+Shift+Down`
  (`Cmd+Shift+Up/Down` on macOS). Open **Window List** with `Ctrl+L`/`Cmd+L`
  and drag a row by its grip or name to a new position, or use its ↑/↓ buttons.
  You can also select a row with arrow keys and use
  `Ctrl+Up/Down`/`Cmd+Up/Down` to reorder it. Shift also works inside the list.
  Enter opens the highlighted window; Escape closes the list.
- Choose a theme, default pane font size, per-session background image, and
  Terminal wheel-scroll speed.
- Persist the active pane and complete workspace document to SQLite.
- Reject stale whole-workspace saves from older tabs or reconnecting computers;
  autosave pauses and offers to reload when a newer revision already exists.
- Detect loss of the server connection and present Reconnect and Refresh Page
  actions. Recovery is confirmed before the current session route is reloaded.
- Reconnect an unexpectedly closed Terminal WebSocket automatically without
  treating that pane transport failure as a server outage.

Window order saves with each session and is shared by keyboard cycling, the
window switcher, Window List, Deskbar, and window menus. Focusing a window keeps
this order. Reordering preserves window positions, stacking, and contents;
minimized windows keep their place and can be moved in the list. Cycling skips
minimized windows. New windows append, and reorder controls stop at the ends.

## Terminal shortcuts

Open **Shortcuts...** from the workspace menu, **Manage shortcuts...** in Settings,
or `CS` in the command palette. Add, edit, duplicate, delete, or test a launcher.
Shortcuts save for the selected user across sessions; concurrent saves report a
conflict and retain your edits until you choose to reload.

For an Editor launcher, set **Name** to `Editor`, **Palette code** to `CE`, and
**Base command** to your installed terminal editor, such as `fresh` or `sati`.
Add a text input named File with an empty CLI switch to pass the filename as a
positional argument. Use `--file` or another switch only if your program supports
it. Text inputs can have defaults or be required; optional empty values omit both
the value and its switch. Boolean inputs append their switch when checked.
Inputs are appended in their configured order, with values quoted for the host's
terminal shell. The base command itself is shell syntax. Quote executable paths
with spaces, and prefix quoted executable paths with `&` in PowerShell.

Invoke `CE` then Enter in the palette, or `C` → `E` in the Command Wheel. Launchers
with inputs show a compact invocation form; launchers without inputs run directly.
Each opens a new terminal titled Editor. A blank working directory uses the current
pane's directory, falling back to the host default; an explicit directory must be
an absolute host path. Restoring a workspace never reruns a shortcut. **Test
shortcut** runs your draft without saving it.

Up to 64 shortcuts and 32 inputs per shortcut are supported. Codes use two uppercase
letters and cannot conflict with built-in commands or other shortcuts. Arguments
support the host's PowerShell or sh/bash/zsh/ksh/fish shell; unsupported custom
shells can run shortcuts without text inputs. Shortcut definitions are local to
this Tessera database and are not included in workspace exports.

## Sign-in

Sign-in is off unless you start Tessera with `-auth=system` or `-auth=file`.

### The host account (`-auth=system`)

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

### Getting in without a password

Every sign-in mode keeps a private recovery token beside the credentials file
(`-auth-token`). Someone on the host, as the account Tessera runs as, can:

```sh
tessera login -addr 127.0.0.1:7331             # prints a one-time link, valid 2 minutes
tessera login -addr 127.0.0.1:7331 -account alice   # with -auth=file
tessera logout -all -addr 127.0.0.1:7331       # ends every sign-in everywhere
```

Pass the server's `-addr` (a `0.0.0.0` address is reached through
`127.0.0.1`). These only work from the host itself.

### Tessera accounts (`-auth=file`)

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
- Passwords are refused over plain HTTP from other devices. Use
  [Local HTTPS](#local-https-for-ipados), or, on a link that is already
  encrypted such as Tailscale or another VPN, start the server with
  `-allow-http-sign-in`.
- **Sign out** is in the desktop menu and the command palette.
- **Settings → Signed-in devices** lists this account's sign-ins, with Sign
  Out for each and Sign Out Everywhere.
- When a sign-in ends (signed out elsewhere, expired, or its password
  changed), open terminal and VNC connections close, and the workspace shows a
  sign-in dialog. Signing in there reconnects the same terminals; their
  programs keep running throughout, and pending changes are saved.
- With `-audit-log`, sign-ins, failures, throttling, sign-outs and recovery
  links are recorded with the sign-in's ID, never passwords or cookies.

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

## Firefox clipboard extension

Firefox 115 ESR users can enable an optional text clipboard bridge under
**Settings → Clipboard**. Tessera bundles the download and setup instructions;
the extension requires explicit approval for each Tessera address. Unsigned
development builds are clearly labeled and require temporary installation.
See [Firefox clipboard documentation](docs/firefox-clipboard.md) for signing,
release packaging, permissions, and updates.

## Desktop and platform behavior

On Windows and macOS, Tessera normally adds a notification-area icon. Its menu
can start and stop the local server, open Tessera in the default browser, check
for and install an update, or exit cleanly. The Update item reports checking,
up-to-date, failure/retry, and restarting states without blocking the native
tray menu. Pass `-tray=false` for server-only/headless use.

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
context actions, and the window button opens the Deskbar. On Windows, allow
inbound TCP ports 7331 and 7332 through Windows Firewall for the active network
profile.

### Phone view

On a phone (a touch screen narrower than 600 points), Tessera shows the
session's terminals as a list rather than as windows. Each card names the
window and says what its shell is doing: running a command (and for how
long), at the prompt, a long command that failed or finished, or a bell or
notification nobody has seen yet, which sort to the top. It also shows the
shell's folder, any progress bar, and the last lines of output. The list
updates as things change while the page is open, holding one request open on
the host rather than connecting to every terminal. Tap a card to use that
terminal full screen; **‹** goes back to the list. **⋯** on a card or the open
terminal sends `Ctrl+C`, renames the window or closes it, **+** starts a new
terminal, and the session name at the top switches sessions. Browser and VNC
windows stay on the desktop view.

Under an open terminal, a compose field takes what you type, dictate or let
the phone correct, and **Send** gives it to the terminal followed by Enter
(hold **Send** to leave out the Enter). It goes in as a paste, bracketed when
the program asked for that, so a multi-line prompt reaches Claude Code as one
message and a shell doesn't run it line by line. What you haven't sent is
kept for that terminal. Above it, a row of the keys a phone keyboard lacks:
Esc, Tab, Shift+Tab, Ctrl, the arrows, `^C`, `^D`, `|`, `~`, `/`, `-` and
Enter. They reach the terminal as key events, so full-screen programs and
the Kitty keyboard protocol get what a keyboard would send. **Ctrl** applies
to the next key, from the row or typed in the field (Ctrl then `r` searches
shell history), and is never a window shortcut. **Type** switches to typing
into the terminal itself, for Vim or `less`.

When a running program has printed nothing for a few seconds, or rang or
notified before you opened it, as Claude Code does when it asks for
permission, a row of one-tap answers appears: `1`, `2`, `3`, `y`, `n`, Enter
and Esc. **123** shows it any time. **☰** lists the terminal's recent commands
and your snippets; tapping one puts it in the field to change or send.
**📎** sends photos or images from the phone (the photo library, the camera
or Files), and a screenshot pasted into the field goes the same way: each is
kept on the host for a week in Tessera's attachments folder
(`~/Library/Caches/tessera/attachments` on macOS, under the user cache
folder elsewhere) and its path goes in the field, so you can write
`what's wrong in <path>` to Claude Code, which reads images from a path. For
a program that takes images only by pasting, **Paste as image instead** puts
a single image on the host's clipboard and sends the program its paste key,
as image paste on the desk does (it needs Tessera in your desktop session).
Snippets belong to your account, so every device has them, and **New…**
starts one from what is in the field. Recent commands come from the shell's
prompt marks, so they need shell integration, and leave out lines the shell
reported only in part (a second line, or past 200 characters).

Opening a terminal on the phone does not move, resize or raise its window,
and does not save the workspace, so the desk's layout is left as it was. Nor
does the phone resize the shell: loading, opening, typing and tapping leave
it at the size the desk gave it, so programs there never reflow because you
looked in. The open terminal shows as **Text** by default: what it holds,
with lines the terminal wrapped joined again and rewrapped to the phone,
following new output unless you scroll up. **Aa** switches to **Screen**,
the terminal itself at the shell's own size in a font small enough to fit
the phone's width (at most down to 4 points; wider terminals scroll
sideways), with **Larger** and **Smaller**. A full-screen program such as
Vim or `htop` always shows as the screen. **Fit to this phone** resizes the
shell to the phone while it stays open there; going back to the list,
putting the phone away or losing the connection gives the shell its earlier
size again, unless a desktop browser has resized it in the meantime. The
**Aa** menu says the shell's size and whose it is. Before the phone adds, renames or closes a window it loads
the newest copy of the workspace, so a window opened at the desk meanwhile is
kept; a desktop browser left open will then offer to reload the newer
workspace on its next change.

**Desktop** at the top of the list switches this browser to windows, and
**Phone View** in the command palette, or opening `/m`, switches it back; the
choice is kept per browser. Reaching Tessera from away from home is best done
over Tailscale or another VPN with [sign-in](#sign-in) on, as described above.

A native iPad and Mac app is in early development in [`apple/`](apple/README.md).
It shows the same web client from a server you choose, with native dialogs,
downloads and plain HTTP over Tailscale. It is built from Xcode, not released.

### Local HTTPS for iPadOS

Open the command palette and run **Local HTTPS...** (`LH`) to configure HTTPS
without changing the service command line. Choose the HTTPS listener, add every
DNS name and LAN or VPN IP address used to open Tessera. Saving creates
Tessera's private root CA, stores the host configuration, and reloads the
listeners in the running process. The primary listener remains available over
HTTP on port 7331 while HTTPS uses port 7332 by default.

Open `http://<host-address>:7331/local-https/` to reach the enrollment page if
the device does not trust HTTPS yet. It downloads only the public root
certificate. On iPadOS, install the downloaded profile, then open **Settings >
General > About > Certificate Trust Settings** and enable full trust for
**Tessera &lt;hostname&gt; Root CA**. Verify the SHA-256 fingerprint against the value
shown in Tessera before enabling trust.

Local HTTPS settings are host-wide and persist in Tessera's SQLite database.
Certificate material is stored in a protected `pki` directory beside the
database. The Ubuntu service therefore keeps its database and CA under
`/var/lib/tessera` across daemon restarts and binary upgrades. Tessera renews
the server certificate when its configured names change or it approaches
expiration; it does not silently replace the root CA.

Only use LAN binding in the trusted-environment model described above. Any
device that can reach the service should currently be treated as having the
ability to operate Tessera and, through Tessera, the host machine.

## Known issues

Two terminal graphics limitations remain under investigation:

- **Windows Chrome graphics stalls:** occasional delayed painting and keyboard
  echo have been measured with both Stable and Experimental renderers. Captured
  long GPU-thread intervals point to the browser/Windows graphics path; the exact native
  cause and a general workaround remain unconfirmed.
- **Rare canvas corruption:** one automated Stable renderer check captured
  colored, translucent pixels below the visible viewport. The saved bitmap
  confirms the damage, but on-screen occurrence is unverified and the severe
  failure did not repeat in 64 standalone checks.

See [Known issues](docs/known-issues.md) for tested scope, recovery/reporting
guidance, and links to the measurements. Automatic canvas context-loss recovery
and the native page-initialization crash repairs are implemented; these two
remaining graphics issues are open.

## Development and testing

Frontend dependencies are bundled with esbuild and committed under
`web/vendor/`:

```powershell
npm install
npm run build:web
```

The VNC bundle uses noVNC 1.7.0 under MPL-2.0 and carries its upstream license
notices beside `web/vendor/vnc.js`.

Routine checks:

```powershell
go test ./...
go vet ./...
node --check web/app.js
node --test internal/terminalcore/core.test.mjs web/*.test.mjs scripts/*.test.mjs extensions/firefox-clipboard/bridge.test.mjs
```

The Go tests cover store migrations and persistence, session lifecycle,
workspace isolation, command streaming, terminals, file operations, desktop
server control, and update behavior. Browser-visible interaction changes still
require focused browser smoke testing.

The host and browser must use the same terminal core. `npm run build:web`
embeds the checked-in WASM artifact; follow the
[terminal core build instructions](docs/terminal-core.md#building-the-patched-core)
when changing native parsing or image behavior.

For browser paint/output measurements, use
[the browser terminal benchmark](scripts/benchmark-terminal-browser.mjs)
with a separately installed Playwright module and Chrome executable:

```text
node scripts/benchmark-terminal-browser.mjs --playwright=<module> --chrome=<executable> --headed=true --group=load --repeats=1
```

The [standalone graphics runner](scripts/terminal-benchmark/graphics-isolation.mjs)
isolates Canvas2D drawing without terminal parsing. It launches its own visible
browser and temporary loopback server. Use untraced runs for latency comparisons;
GPU device timing can change the behavior being measured. See the
[isolation report](docs/terminal-graphics-isolation-2026-10-05.md) for commands
and the [graphics reliability report](docs/terminal-graphics-reliability-2026-10-05.md)
for the real test-browser GPU-process recovery control.

Database schema changes belong in the next contiguous numbered SQL file under
`migrations/`. Those files are embedded into the executable and applied in
order using SQLite `PRAGMA user_version`. Treat applied migration files as
immutable; append a new migration instead of editing an existing one.

## Releases and self-update

The **CI and Release** workflow runs only when a `v*` tag is pushed; branch
pushes, pull requests, and manual dispatch trigger nothing (the daily artifact
cleanup still runs on its schedule). On a tag, the **CI and Release** workflow
builds every generated file from source in one job: the terminal core (Zig),
the browser bundles (`web/vendor/`) and the clipboard extension package
(`web/extensions/`). It fails if any committed copy differs from what it built,
so a checkout always builds what was released, and runs every JavaScript test.
Each platform job then runs the Go tests and builds its binary over those
built files, not the committed copies, and the release publishes:

- `tessera-linux-amd64`
- `tessera-linux-arm64`
- `tessera-windows-amd64.exe`
- `tessera-darwin-arm64`
- Verified original LAME companions, source, and license for legacy updater compatibility

x64 and amd64 are the same architecture. Native platform jobs use GitHub's
[supported runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Missing or empty server assets stop release publication. The audio and file OSC
CLI programs are maintained and released in an independent repository. Tessera
continues to implement both protocols; see [terminal audio](docs/terminal-audio.md)
and [file transfers](docs/terminal-files.md).

Linux and Windows builds use `CGO_ENABLED=0`. Linux builds run server-only
without tray support. The macOS ARM build runs on a native macOS runner with
`CGO_ENABLED=1` for tray support. Intel macOS and BSD targets are currently
disabled in the workflow.

The in-app updater checks the latest GitHub Release, downloads the Tessera
executable matching the current operating system and architecture, installs it
with rollback on failure, and restarts Tessera without requiring
manual file replacement. After the old server releases its listener,
sessions and database, every desktop platform starts the
replacement as an independent process. The old process remains alive until the
replacement confirms that its server started; startup failures are returned to
the old process and logged instead of treating process creation as a successful
restart.

An Ubuntu installation created by `install-ubuntu.sh` follows a service-aware
path. **Update Server** checks the release normally, then offers **Open Update
Terminal**. Tessera opens a foreground Terminal and starts a root transient
systemd unit; enter the account's `sudo` password there when prompted. The
transient unit uses the same transactional updater, survives the shutdown of
the original service cgroup, and asks systemd to restart and verify
`tessera.service`. The existing unit file, service user, database path, command
arguments, and listen address are not rewritten. The Terminal disconnects when
the old service stops, and the page reloads after the expected new version
answers its health check. If the privileged update fails, inspect
`journalctl -u 'run-*.service'` and `journalctl -u tessera.service`; rerunning
`install-ubuntu.sh` from an external shell remains the recovery path.

Releases retain the original v1.9.0 LAME companions, source archive, and license
as compatibility assets for older updaters. Those updaters require a companion
before they can install Tessera v1.9.1 or later. The files are copied with pinned
size/SHA-256 checks; LAME is no longer built or used by Tessera. New updaters
install only Tessera; install/update external OSC CLI tools separately.

To prepare the same compatibility assets for repairing an existing release:

```text
node scripts/prepare-legacy-update-assets.mjs .cache/legacy-update-assets
```

An executable-only release published without these compatibility assets still
requires a manual executable replacement or Ubuntu installer rerun when updating
from a LAME-dependent version.

Anonymous GitHub Releases API access is used, so release assets must be
reachable without private repository credentials.

### Terminal file transfers

Terminal applications can use the [file transfer protocol](docs/terminal-files.md)
on the Tessera host to upload files from an attached browser or download host
files. Batch downloads stream as ZIP; file bytes never enter terminal history.
The file CLI is maintained and released in an independent repository.
Browser selection/approval is required; remote SSH transfers and
directories are outside v1. Saved File Browser panes become terminals in their
existing directories. Text Editor and Worksheet panes are also retired: saved
text, tabs, file paths, and modes remain archived in workspace data, while their
panes become terminals. Moving or saving the workspace preserves these archives;
no saved text is executed. Edit files and keep notes using terminal applications.
The terminal working-directory picker remains available.
