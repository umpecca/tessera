# Deployment

## Ubuntu service

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
[terminal audio](terminal-audio.md).

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

## Tray and platform builds

On Windows and macOS, Tessera normally adds a notification-area icon. Its menu
can start and stop the local server, open Tessera in the default browser, check
for and install an update, or exit cleanly. The Update item reports checking,
up-to-date, failure/retry, and restarting states without blocking the native
tray menu. Pass `-tray=false` for server-only/headless use.

Linux releases run server-only without a tray, keeping the executable CGO-free
and avoiding GTK/AppIndicator dependencies. macOS tray builds use CGO. Windows
tray builds remain CGO-free and may use `-ldflags=-H=windowsgui` to hide the
console window.

## macOS notes

For an unsigned downloaded binary:

```bash
chmod +x /path/to/tessera
xattr -d com.apple.quarantine /path/to/tessera
```

If filesystem access prompts stall the host process, grant Full Disk Access to
the process that launches Tessera, such as Terminal, iTerm2, or the packaged
Tessera application. A future `.app` bundle and signing flow should provide a
more conventional macOS installation.
