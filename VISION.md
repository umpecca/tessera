# Tessera vision

**Your machine, from any browser: its shell, its screen and its dev servers,
in sessions that stay put, as fast as the link allows.**

## What Tessera is

Tessera is how you reach the machine it runs on. Install it on each computer
you use, such as a headless Mac, a Linux VPS or VM, or a Windows development
box. Then open it from any browser, an iPad or a phone included. Every pane is
that machine:

- its **shell** in a terminal,
- its **screen** over RDP or VNC,
- its **dev servers** in a Browser pane,

all laid out as windows on a desktop that is saved with the rest of your work.
Share the link, and each person signs in with their own account on the
machine and works as that account.

Tessera is not a gateway to other machines. It has no address book, no SSH
pane and no list of servers, because the machine is always the one Tessera
lives on. Several machines means several Tesseras.

## Principles

1. **Performance first, and measured.** Every pane is as fast as the link
   allows, and "fast" is a number from a benchmark, not a feeling. Work that
   claims a speedup brings its measurements, as the terminal's did
   (docs/terminal-performance-2026-10-04.md).
2. **Straightforward.** If Tessera can find something out, it doesn't ask.
   There is one obvious way to do each thing, and it works without settings.
   Options exist for the cases that need them; they aren't the way in.
3. **This machine only.** No feature reaches beyond the host, which keeps
   the product simple and its security boundary small.
4. **Sessions stay put.** Closing the tab, losing the network or putting the
   iPad or phone to sleep leaves the work where it was. Every kind of session is kept
   on the host, not in the page.
5. **Any browser, with the iPad and the phone as first-class clients.** No
   native client to install. Touch, Retina, Safari and a flaky connection
   are designed for, not tolerated. A phone isn't a small desktop: it shows
   one pane at a time, full screen, made to be used with a thumb.

A pane earns its place by being **kept on the host and measured**. That is
the line between a sharp tool and a Swiss army knife that does everything
halfway.

## What's in

- **Terminal.** This machine's shell. It stays running on the host and
  restores on reconnect, and offers typing prediction for slow links, Sixel
  images and the Kitty keyboard protocol.
- **Screen.** This machine's own display, through the screen server it
  runs. One pane finds what's there and connects; see "The Screen pane" below.
- **Browser pane.** The dev servers on this machine, shown through
  Tessera's own listener, with their storage and cookies kept by Tessera.
- **Utilities that serve a session:** file transfer, clipboard,
  notifications from programs, and launch shortcuts.
- **The desktop:** windows, layouts, workspaces, the command palette and
  the Deskbar, so several sessions sit side by side.
- **Phone access.** The phone view lists your panes and opens one at a time
  across the whole screen. Its terminals already work there with touch
  input, the phone's own keyboard and image attachments (tasks 231, 232 and
  234). It's installed as a Home Screen web app, using Local HTTPS.

## Out of scope

- Reaching other machines: address books, saved connections, SSH, jump
  hosts.
- General desktop features that don't help a session on this machine.

Existing features that don't fit stay unless they cost something. New work is
ranked by this document.

## What follows

- **The VNC and RDP bridges connect to loopback only.** Today they can reach
  any TCP address, which ARCHITECTURE.md lists as a deliberate, broad
  exception. Once each machine runs its own Tessera, that exception goes away.
- **You sign in as yourself.** Any account on this machine that is allowed
  in can sign in with its own password, and everything it does (shell,
  files, commands) runs as that account, never as Tessera's. Host-account
  sign-in is the natural default; Tessera accounts remain for machines
  without a usable host password.
- **Detect, don't configure.** Screen servers, dev server ports and HTTPS
  are found or set up by Tessera, not typed in.

## The Screen pane

One pane replaces the separate VNC and RDP panes:

- **It finds the servers.** It probes this machine's listening ports and
  identifies RDP and VNC servers by their opening handshake, so a server on
  an unusual port is still found.
- **It prefers RDP when one answers.** RDP is the fastest path today, with
  H.264, full color (AVC444) and kept sessions; VNC is the fallback. The
  order is revisited with measurements once VNC has host-side H.264.
- **Both stay choosable.** When both are present, the pane shows an RDP /
  VNC choice, remembered per window. With only one, there is nothing to
  choose.
- **It explains what's missing.** When nothing answers, it says how to turn
  a screen server on for this OS.

| Machine | Screen servers |
| --- | --- |
| macOS | Remotr (RDP) for the best picture; Screen Sharing (VNC) built in |
| Linux | xrdp (RDP); wayvnc or x11vnc (VNC) |
| Windows | Remote Desktop, but connecting to itself is limited (below) |

Windows needs checking early. The Remote Desktop client refuses `localhost`.
On non-server editions, signing in takes over the console session and locks
the physical screen. Windows Home has no RDP server at all. Native capture
(see "Later") may matter sooner there.

## Roadmap

**Now**

1. **Sign in as yourself.** Any local account allowed in (members of a
   `tessera` group, plus admins) signs in with its own password, and its
   panes run as that account. The design is privilege separation, as in
   `sshd` and Cockpit:
   - The web server runs unprivileged.
   - A small root helper checks passwords and starts a worker per account,
     with that account's groups, home and shell.
   - Everything that touches the host goes through the signed-in person's
     worker: terminals, shortcuts, files, transfers and clipboard.

   Workspaces and settings stay per account, and admins manage Tessera's own
   settings. Linux and macOS come first; Windows follows. Tessera becomes a
   system service, which brings part of "Setup in a minute" with it. On
   Linux the Browser pane shows each person the dev servers their account
   runs.
2. **Measurements for RDP.** A repeatable harness, as the terminal has, with
   a recorded stream, decode and draw times, queue depth, dropped frames, a
   soak test, and an on-screen stats overlay. It starts by checking that
   pausing unseen video (task 243) works against Remotr.

**Next**

3. **The Browser pane lists this machine's dev servers** from its listening
   ports, instead of asking for an address.
4. **Every pane on a phone.** Today the phone view shows only terminals; a
   screen or Browser pane has to be opened from the desktop view. The
   screen on a phone (task 240):
   - The remote desktop keeps a desktop size, and the phone zooms and pans
     over it, so a kept session's layout isn't rearranged for a 390-pixel
     screen.
   - A tap clicks, a long press right-clicks, and two fingers scroll.
   - The phone's own keyboard sends text as characters, whatever the remote
     keyboard layout.

   The Browser pane follows, full screen in the phone view.
5. **The Screen pane**, with detection, and the bridges restricted to
   loopback. First, test RDP from Windows into itself (see "The Screen
   pane"); until Windows has a working path, restricting the bridges would
   cut off RDP to a Windows machine from another Tessera.
6. **The rest of setup:** HTTPS on by default, and an iPad or phone paired
   by QR code.
7. **VNC at RDP's standard:**
   - kept on the host,
   - paused while unseen (VNC asks for each update, so a kept session simply
     stops asking),
   - resolution, Resize, Resize ×2 and sharp rendering where the server
     allows,
   - the mouse wiggle,
   - reconnect,
   - measurements, with the RDP harness.
8. **Host-side H.264 for VNC.** The VNC server is on the same machine, so
   Tessera can take raw pixels from it at memory speed. It encodes H.264 with
   the hardware encoder (VideoToolbox, Media Foundation, VAAPI) and the
   browser decodes it with WebCodecs, as for RDP. Every VNC server, macOS
   Screen Sharing included, then gets H.264.

**Later**

9. **Native capture.** Tessera captures the screen itself, through
   ScreenCaptureKit, Desktop Duplication or PipeWire, and feeds the H.264
   encoder from item 8, with no screen server to set up. The hard parts are
   input injection and each OS's permissions. If RDP from Windows into
   itself turns out unusable (item 5), native capture on Windows moves up,
   and the encoder is built there rather than for VNC.
10. **My machines:** a small switcher between your Tesseras. It holds links,
    never a gateway.

## Deciding on new work

- Does it help reach **this machine**?
- Is it as fast as it can be, **with numbers** to show it?
- Does it work **without configuration**?
- Does it hold up **on an iPad and a phone** over a poor connection?
- Is the session it serves **kept on the host**?

Work that fails these can still be worth doing, but it waits behind work that
passes them.
