# VNC and RDP panes

## VNC

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
pixels with scrolling. When the server sends no cursor shape, as macOS Screen
Sharing does, the pointer is shown as a small dot. **View only** suppresses remote input. Clipboard text is
never moved automatically: the up-arrow sends local clipboard text and the
down-arrow copies the most recently received remote text. A visible text field
is offered when the browser refuses clipboard access.

## RDP

RDP panes connect to an existing RDP server, such as Windows Remote Desktop,
`xrdp` or another standard implementation, on any address the Tessera host
can reach. The browser runs the IronRDP client; Tessera opens the TCP
connection, performs the server's TLS handshake, and relays the session
over the page's WebSocket (IronRDP's RDCleanPath protocol). The server must
offer TLS or Network Level Authentication (CredSSP); servers limited to the
legacy Standard RDP Security are refused. macOS has no built-in RDP server, so
use a VNC pane for a Mac's own Screen Sharing.

Because Tessera completes TLS with the server, the session is decrypted on the
Tessera host and travels between the browser and Tessera inside the page's
connection. Serve Tessera over HTTPS, or use it on loopback, when the session
crosses a network; the sign-in dialog warns otherwise. On first connection,
and whenever a server's certificate changes, the pane shows its subject,
expiry and SHA-256 fingerprint; Tessera refuses to relay a connection whose
certificate differs from the one you accepted. Like the VNC bridge, the RDP
gateway can reach any TCP destination, so the same trusted-users rule applies.

**Fit** scales the remote desktop into the window, **1:1** shows native pixels
with scrolling, and **Resize** asks the server to change its resolution to
match the window (servers without the Display Control channel keep their
size). **Resize ×2** does the same at half the window's size and shows the
desktop doubled, so in a large window the remote text and windows keep their
usual size, a little softer, with a quarter of the pixels to send. **CAD** sends Ctrl+Alt+Del and **Win** the Windows key; the Command key
on a Mac is sent as the Windows key. Clipboard text works as in VNC panes:
the up-arrow sends local text and the down-arrow copies the remote text.
**Wiggle when away**, remembered per window, moves the remote mouse a pixel
and back once a minute while the window isn't the one you're using (another
window is active, or the browser isn't in front), so the remote session
doesn't go idle or lock; **Wiggle always** does so even while you are using
it, for a remote desktop you watch without touching. For a [kept session](#kept-rdp-sessions) the Tessera host does
the wiggling, so it goes on with the page closed or paused in a background
tab; otherwise the page does it and needs to stay open. Audio, drive and printer redirection, RD Gateway and Kerberos are not
included, and a pane that isn't [kept on the host](#kept-rdp-sessions) doesn't
reconnect by itself.

When Tessera is opened over HTTPS (or on loopback) in a browser that can decode
H.264, the pane offers the server the Graphics Pipeline with H.264 video. The
browser decodes it, in hardware where it can, and draws it straight onto the
pane, which needs far less bandwidth than bitmap updates and, on an iPad, is
much faster; the toolbar shows **H.264** while it is in use. Over plain HTTP,
or when the server doesn't send H.264, the pane uses bitmap updates instead.
This has been tested with Remotr on macOS from iPad Safari. The pane shows the
browser's own pointer shapes rather than the server's. If wheel or trackpad
scrolling moves too far, lower **Settings > Scroll wheel > Remote desktop**
(saved per browser).

Servers may send H.264 in 4:4:4 (AVC444), which keeps colored text and thin
colored lines sharp. The sign-in dialog's **Full color (4:4:4) when the server
sends it** combines it into full color with the browser's WebGL2; the toolbar
then shows **H.264 4:4:4**. Off (the default), the pane shows the same stream
at 4:2:0, which is lighter on the device. The client can't ask the server for
one or the other: whether 4:4:4 is sent is the server's choice. The option is
remembered in this browser and also applies to kept sessions it opens.

The sign-in dialog's **Resolution**, remembered per window, asks for the
desktop at the window's own size (the default) or at a fixed size such as
1920 × 1080. A fixed size stays as chosen: **Fit** scales it into the window
and **1:1** shows it with scrolling. Connecting at a fixed size switches a
window in **Resize** or **Resize ×2** mode to **Fit**; choosing either again
afterwards makes the desktop follow the window once more. Sharp mode isn't
offered with a fixed size or in **Resize ×2**.

On a Retina or other high-resolution screen, the sign-in dialog also offers
**Sharp on this high-resolution screen**. It asks for the desktop at the
screen's own resolution (at most twice its size in points) and shows it pixel
for pixel, so text is crisp instead of stretched, and the remote desktop's text
and windows look smaller, with more room. It sends about four times the pixels,
so it suits a fast connection; it is off by default and remembered in this
browser, and a kept session stays at the resolution it was started with.

With Sharp on, **Keep the remote text full size (Remotr Retina mode)**
has Remotr lay out a Retina desktop instead, so text and windows keep their
usual size. Remotr does this only up to 1920 pixels wide, 1920×1200 in all and
16:9 wide, and only once its display is running, so Tessera connects at the
usual size and switches a second later, with Remotr's Connecting screen in
between; a larger or wider window gets the largest such desktop that fits,
enlarged a little. If Remotr doesn't come back from the switch within five
seconds, Tessera returns it to the usual size for the rest of the connection. The
choice is remembered for the window.

## Kept RDP sessions

With [sign-in](sign-in.md) on, and Tessera opened over HTTPS or on loopback, the
RDP sign-in dialog offers **Keep this session on the Tessera host**. A kept
session's RDP client runs on the Tessera host instead of in the page, so the
session stays logged in when you close the tab, reload, switch workspace or
put the iPad to sleep. Open the window again, from any browser signed in to
the same account, and it shows the desktop where you left it, without asking
for the password; the toolbar shows **On host**. The choice is remembered in
this browser.

- **Disconnect**, or closing the window, ends the session, as a client
  disconnecting would; a Mac running Remotr stays at its login screen.
- A session ends after **8 hours** with no browser attached; change this with
  `-rdp-idle-limit` (for example `-rdp-idle-limit 2h`, at least `1m`). The
  sign-in dialog says what the limit is.
- Restarting or updating Tessera ends every kept session.
- If the connection to the RDP server drops, the window asks for the password
  again and rejoins the same desktop session with the server's reconnect
  cookie. The server's certificate must still be the one you trusted.
- One browser shows a session at a time; opening it in another takes it over,
  and the first shows that it was taken over.
- While the window can't be seen (minimized or fully covered for 2 seconds,
  the tab in the background, or the phone view showing), the server stops
  sending video, which saves the host's and the browser's work and an
  iPad's battery. The window keeps its last picture, and the server sends
  the whole screen again once it can be seen. The session itself, the
  mouse wiggler included, carries on.
- Only the account that kept a session can see or end it. Signing out closes
  the view but leaves the session running until it is ended or idles out.
- Clipboard text isn't available in kept sessions yet.
- A session kept from a browser that decodes H.264 stays on H.264, so view it
  from browsers that can decode it too; one that can't shows only the parts
  of the screen the server sends as bitmaps.

The password travels to the host once, to log in, and is wiped from the RDP
client's memory as soon as it is read; Tessera never stores it. While a kept
session runs, the host holds a logged-in connection to the RDP server, so a
Tessera account is as powerful as the remote desktops it keeps. The server's
own lock screen is unaffected: anyone at a Mac's own keyboard still has to log
in.
