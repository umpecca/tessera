# Development and releases

## Building and testing

Frontend dependencies are bundled with esbuild and committed under
`web/vendor/`:

```powershell
npm install
npm run build:web
```

The VNC bundle uses noVNC 1.7.0 under MPL-2.0 and carries its upstream license
notices beside `web/vendor/vnc.js`. The RDP bundle is IronRDP's
`@devolutions/iron-remote-desktop-rdp` web package under MIT or Apache-2.0,
built from an IronRDP `master` commit with Tessera's patches for H.264; both
notices are beside `web/vendor/rdp.js`. That bundle is prebuilt rather than
built by `npm run build:web`; `third_party/ironrdp/README.md` lists the commit
and patches and explains how to rebuild it. After upgrading it, run
`TESSERA_RDP_INTEROP=1 go test ./internal/httpapi -run IronRDP` to drive the
bundled client against the gateway.

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
[terminal core build instructions](terminal-core.md#building-the-patched-core)
when changing native parsing or image behavior.

For browser paint/output measurements, use
[the browser terminal benchmark](../scripts/benchmark-terminal-browser.mjs)
with a separately installed Playwright module and Chrome executable:

```text
node scripts/benchmark-terminal-browser.mjs --playwright=<module> --chrome=<executable> --headed=true --group=load --repeats=1
```

The [standalone graphics runner](../scripts/terminal-benchmark/graphics-isolation.mjs)
isolates Canvas2D drawing without terminal parsing. It launches its own visible
browser and temporary loopback server. Use untraced runs for latency comparisons;
GPU device timing can change the behavior being measured. See the
[isolation report](terminal-graphics-isolation-2026-10-05.md) for commands
and the [graphics reliability report](terminal-graphics-reliability-2026-10-05.md)
for the real test-browser GPU-process recovery control.

Database schema changes belong in the next contiguous numbered SQL file under
`migrations/`. Those files are embedded into the executable and applied in
order using SQLite `PRAGMA user_version`. Treat applied migration files as
immutable; append a new migration instead of editing an existing one.

## Bundled pixel fonts

The optional pixel terminal fonts are stored in `web/assets/`, with their
upstream licenses beside them. Font bytes are unmodified (some filenames are
normalized); there is no CDN request or font conversion in the build:

| Font | Upstream source | Bundled faces | License |
| --- | --- | --- | --- |
| Spleen | [2.2.0 release](https://github.com/fcambus/spleen/releases/tag/2.2.0), `spleen-2.2.0.tar.gz` | `spleen-8x16.woff2` → `Spleen-8x16.woff2`; regular only | `Spleen-LICENSE.txt` (BSD-2-Clause) |
| Pixel Operator Mono | [Author's download](https://www.dafont.com/pixel-operator.font), `pixel_operator.zip`, version 2018.10.04-1 | `PixelOperatorMono.ttf` → `PixelOperatorMono-Regular.ttf`, plus `PixelOperatorMono-Bold.ttf` | Archive's `LICENSE.txt` → `PixelOperator-CC0.txt` (CC0-1.0) |
| scientifica | [v2.3 release](https://github.com/oppiliappan/scientifica/releases/tag/v2.3), `scientifica.tar` | `ttf/scientifica.ttf` → `scientifica-Regular.ttf`; `ttf/scientificaBold.ttf` → `scientifica-Bold.ttf` | [Tagged LICENSE](https://github.com/oppiliappan/scientifica/blob/v2.3/LICENSE) → `scientifica-LICENSE.txt` (OFL-1.1) |
| Cozette | [v.1.30.0 release](https://github.com/the-moonwitch/Cozette/releases/tag/v.1.30.0) | `CozetteVector.woff2`; regular only | Release's `LICENSE` → `Cozette-LICENSE.txt` (MIT) |

Pixel Operator is by Jayvee Enaguas (HarvettFox96). Its original NotABug source
URL is no longer available, so the fonts and CC0 license come from the author's
DaFont upload. Cozette's vector export is necessary for browser use; upstream
warns that it may not render as crisply as its native bitmap formats. Cozette's
upstream bold export has a wider character advance than regular, so Tessera uses
browser-synthesized bold to preserve terminal alignment, as it does for Spleen.

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

x64 and amd64 are the same architecture. Native platform jobs use GitHub's
[supported runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Missing or empty server assets stop release publication. The audio and file OSC
CLI programs are maintained and released in an independent repository. Tessera
continues to implement both protocols; see [terminal audio](terminal-audio.md)
and [file transfers](terminal-files.md).

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

The updater installs only Tessera; install/update external OSC CLI tools
separately. Versions v1.4.0 through v1.9.0 can't update themselves to current
releases: their updater requires a LAME companion asset that releases no longer
include. Update those by replacing the executable by hand or rerunning the
Ubuntu installer.

Anonymous GitHub Releases API access is used, so release assets must be
reachable without private repository credentials.
