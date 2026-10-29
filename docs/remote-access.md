# Access from an iPad, a phone or another device

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

## Phone view

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
terminal, and the session name at the top switches sessions. Browser, VNC and
RDP windows stay on the desktop view.

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
over Tailscale or another VPN with [sign-in](sign-in.md) on.

## Native iPad and Mac app

A native iPad and Mac app is in early development in [`apple/`](../apple/README.md).
It shows the same web client from a server you choose, with native dialogs,
downloads and plain HTTP over Tailscale. It is built from Xcode, not released.

## Local HTTPS for iPadOS

Open the command palette and run **Local HTTPS...** (`LH`) to configure HTTPS
without changing the service command line. Choose the HTTPS listener, add every
DNS name and LAN or VPN IP address used to open Tessera. Saving creates
Tessera's private root CA, stores the host configuration, and reloads the
listeners in the running process. The primary listener remains available over
HTTP on port 7331 while HTTPS uses port 7332 by default. RDP windows need HTTPS
for H.264 video, since browsers decode it only on secure pages.

Open `http://<host-address>:7331/local-https/` to reach the enrollment page if
the device does not trust HTTPS yet. It downloads only the public root
certificate. On iPadOS, install the downloaded profile, then open **Settings >
General > About > Certificate Trust Settings** and enable full trust for
**Tessera &lt;hostname&gt; Root CA**. Verify the SHA-256 fingerprint against the value
shown in Tessera before enabling trust.

Local HTTPS settings and certificate material, including the root CA's
private key, are host-wide and persist in Tessera's SQLite database, which
only the account Tessera runs as can read. Earlier versions kept the
certificates in a `pki` directory beside the database; Tessera imports them
once, keeping the same root CA, and no longer uses the directory. The Ubuntu
service keeps its database under `/var/lib/tessera` across daemon restarts
and binary upgrades. Tessera renews
the server certificate when its configured names change or it approaches
expiration; it does not silently replace the root CA.

Only use LAN binding in the trusted-environment model described above. Any
device that can reach the service should currently be treated as having the
ability to operate Tessera and, through Tessera, the host machine.
