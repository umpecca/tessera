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

On a phone (a touch screen under 600 points on its shorter side, held either
way, or any touch screen in a window narrower than that), Tessera shows the
session's terminals as a list rather than as windows. Each card names the
window and says what its shell is doing: running a command (and for how
long), at the prompt, a long command that failed or finished, or a bell or
notification nobody has seen yet, which sort to the top. It also shows the
shell's folder, any progress bar, and the last lines of output. The list
updates as things change while the page is open, holding one request open on
the host rather than connecting to every terminal. Tap a card to use that
terminal full screen. Its buttons sit at the ends of the key row under it, so
the terminal reaches the top of the screen: **‹** goes back to the list, and
**Aa** and **⋯** are at the right. Tapping **⋯** or **Aa** again closes its
menu; tapping outside closes it too. **⋯** on a card or the open terminal sends
`Ctrl+C`, renames the window or closes it (for the open terminal it is headed
by the window's name and what its shell is doing), **+** starts a new
terminal, and the session name at the top switches sessions. Browser, VNC and
RDP windows stay on the desktop view.

Under an open terminal, a compose field takes what you type, dictate or let
the phone correct, and **Send** gives it to the terminal followed by Enter
(hold **Send** to leave out the Enter). It goes in as a paste, bracketed when
the program asked for that, so a multi-line prompt reaches Claude Code as one
message and a shell doesn't run it line by line. What you haven't sent is
kept for that terminal. Above it, a row of the keys a phone keyboard lacks:
Esc, Tab, Shift+Tab, Ctrl, the arrows, `^C`, `^D`, `|`, `~`, `/`, `-` and
Enter. **Copy** copies highlighted terminal cells; **Paste** sends clipboard
text directly to the program, bracketed when requested, without appending Enter
or opening the keyboard. They are clipboard actions, not Ctrl+C/Ctrl+V shortcuts.
If browser clipboard access is blocked, Paste can use Tessera's last copy and
says so; native clipboard permission prompts still apply.

The other keys reach the terminal as key events, so full-screen programs and
the Kitty keyboard protocol get what a keyboard would send. **Ctrl** applies
to the next key, from the row or typed in the field (Ctrl then `r` searches
shell history), and is never a window shortcut. **Type** switches to typing
into the terminal itself, for Vim or `less`; only it opens the keyboard, so
tapping or scrolling the terminal doesn't. While the keyboard is up, **⌄** at
the start of the row puts it away and stops typing directly. **Select** keeps
the normal terminal screen visible, including a full-screen program's layout
and colors. Drag across cells to highlight text, then tap **Copy**. **Done**
(or Select again in Interact) returns without opening the keyboard. Selection
drags stay local: they never become application mouse presses. A saved Text
view preference is restored after selection ends.

For mouse-aware full-screen programs such as Fresh, **TUI ↑** and **TUI ↓**
appear beside Copy while **Select** is open. These scroll the running program
so you can reach more text before selecting it. Two fingers can also scroll
the TUI; a single finger selects. TUI navigation clears the previous selection
and requires mouse support: it never falls back to typing arrow keys into a
shell. The screen remains live, so copy before program output changes the text.

Opening the compose keyboard keeps the shell's grid and existing terminal canvas
stable, panning its last rows above the keyboard instead of repeatedly resizing
the program. After the keyboard closes and settles, fitting resumes. **Type**
still uses the terminal's normal direct-input behavior. Editable fields keep a
16px minimum even with a smaller interface setting, to avoid Safari auto-zoom.

**123** shows or hides a row of one-tap answers: `1`, `2`, `3`, `y`, `n`, Enter
and Esc. The choice is remembered in this browser across terminals and reloads.
The row never opens or closes automatically because a program goes quiet,
prints output, rings an alert or receives an answer. **☰** lists the terminal's recent commands
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

In **Scroll** mode, **Page Up** and **Page Down** at the bottom move through
local text or canvas history one visible page at a time, with a little overlap.
They never send PageUp/PageDown keys, mouse events or other input to the running
program. Full-screen programs still use the existing two-finger application scroll.
Phone-layout terminal scroll gestures have a 35% distance boost for less finger
travel; selection precision, page-button distances and desktop/tablet layouts
are unchanged.

**Select** is also available beside the page buttons. It selects cells on the
normal canvas while you remain in Scroll mode, with **Copy**, **Done** and
mouse-aware **TUI ↑/↓** navigation replacing the page buttons. No typing controls
or keyboard are needed. **Done** restores the page buttons and stays in Scroll.
In Interact, application mouse gestures still reach Fresh, but tapping the
canvas no longer focuses terminal input: only an explicit **Type** action does.

Opening a terminal on the phone does not move, resize or raise its window,
and does not save the workspace, so the desk's layout is left as it was.
The open terminal shows as **Screen** by default. **Aa** switches to
**Text**: what it holds, with lines the terminal wrapped joined again and
rewrapped to the phone, following new output unless you scroll up. Without
Fit, the screen is the terminal itself at the shell's own size in a font small enough to fit
the phone's width (at most down to 4 points; wider terminals scroll
sideways), with **Larger** and **Smaller**. A full-screen program such as
Vim or `htop` always shows as the screen. A terminal opened on the phone is
**Fit to this phone**: the shell takes the phone's size while it stays open
there (turn it off in **Aa** to look in at the desk's size). The fitted
screen and the text view use a font size each terminal keeps on the phone,
apart from the desk's: **Larger** and **Smaller** change it a pixel at a
time, starting from the phone's default font size, and the phone's browser
remembers it. Going back to the list gives the shell its earlier size
again, unless a desktop browser has resized it in the meantime; putting the
phone away or losing the connection does the same after 45 seconds, so a
phone taken straight back out, or switching from Wi-Fi to mobile data, picks
up where it was without the shell being resized twice. The
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

The HTTPS listener speaks HTTP/2, so a browser loads Tessera's modules over
one connection instead of six; WebSockets still upgrade over HTTP/1.1. Start
Tessera with `GODEBUG=http2server=0` to turn HTTP/2 off.

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
