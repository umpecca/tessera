# Task 228: Clipboard image paste

Status: complete for macOS (iPad check pending); Windows and Linux built and unit-tested, not yet tried on a host; headless Linux deferred

## Request

Pasting a screenshot from iPadOS into opencode running in a Tessera
terminal does nothing. Make Cmd+V (Ctrl+V off Apple keyboards) the one paste
key for everything on the clipboard, images included, on every server
platform, without writing pasted data to disk.

## Findings

- The browser paste handler (`attachTerminalPasteBridge`, `web/app.js`)
  reads only `text/plain`. An image-only clipboard yields empty text, so the
  event is cancelled and nothing is sent. No code in `web/` reads clipboard
  images; image paste has never worked through Tessera.
- On an Apple keyboard Ctrl+V reaches the PTY as `^V`
  (`web/terminal-keyboard.mjs`). opencode then reads the **server's**
  clipboard, which never holds the iPad's image.
- It has appeared to work: with the server on the user's Mac, Ctrl+V in
  opencode showed an image placeholder. Universal Clipboard (Handoff) had
  synced the iPad screenshot to the Mac's clipboard, and opencode read it
  there; Tessera carried nothing. That path fails silently (Handoff off,
  devices apart, items expire after about two minutes), and Cmd+V never
  worked. The design below does deliberately what Handoff did by accident.
- A terminal carries only text, so there is no in-band way to give a program
  an image. kitty's typed-clipboard protocol exists but opencode and most
  programs do not support it.
- Programs such as opencode and Claude Code paste images by reading the host
  system clipboard: AppleScript on macOS, PowerShell on Windows, `wl-paste`
  or `xclip` on Linux. (Confirm each when implementing.)
- The existing terminal file upload (`docs/terminal-files.md`) is started
  by a program's request, so it does not fit a browser-initiated paste.
- Rejected: uploading to a temp or RAM-backed folder and pasting the path.
  It leaves files to clean up, `/dev/shm` exists only on Linux, and it
  works around the programs instead of with them.

## Design

Forward the browser's clipboard to the host clipboard, the way RDP and X11
forwarding do.

1. Cmd+V with an image and no text: the trusted paste event carries the
   image with no permission prompt. The browser uploads it to the server.
2. The server writes it to the host clipboard, in memory.
3. Tessera sends the program its paste key (`^V`), and the program reads
   the clipboard as it would locally.

Text pastes are unchanged. `^V` is sent only for image-only pastes, so a
text paste never becomes a keystroke.

### Host clipboard backends

One host-clipboard component with a backend per platform:

| Server | Backend | Real system clipboard |
|---|---|---|
| macOS | `NSPasteboard` through `purego` (already used for OpenDirectory) | Yes |
| Windows | Win32 clipboard API through `syscall`, no cgo | Yes |
| Linux desktop | `wl-copy` (Wayland) or `xclip` (X11) when installed | Yes |
| Linux headless | In-memory clipboard, plus stand-in `wl-paste`/`xclip` on the `PATH` of Tessera's terminals that read it | Virtual |

- macOS and Windows need Tessera running in the logged-in desktop session
  (the tray app), not as a background service.
- Linux desktop falls back to the in-memory backend when neither tool is
  installed.
- `golang.design/x/clipboard` covers all three but needs cgo on macOS and
  Linux; the Linux and Windows releases are cgo-free, so write small
  backends instead.

### Security

- Accept only from a signed-in session, triggered by a real paste event.
- Apply a size limit like the upload limit.

### Open questions

- Should text pasted from the browser also be copied to the host clipboard
  so `pbpaste` and other host apps see it? Proposed: behind a setting.
- Recent macOS versions can prompt before an app reads the clipboard
  programmatically, and a denial makes `osascript -e 'clipboard info'`
  return nothing. Check whether opencode's read through Tessera's PTY is
  subject to that prompt, and which app macOS attributes it to.
- Is `^V` the right paste key for every program, or should it be
  configurable?

## Changes

- `internal/hostclipboard`: `ParseImage` checks the bytes are PNG, JPEG or
  GIF (32 MiB at most) whatever the browser declared; `Detect` reports the
  backend and session; `WriteImage` replaces the clipboard.
  - macOS: `NSPasteboard` through purego (`public.png`/`public.jpeg`/GIF),
    read back to confirm. Security.framework `SessionGetInfo` without
    graphic access, or root, is a service (LaunchDaemon or SSH).
  - Windows: Win32 clipboard through `syscall`, registered `PNG` plus
    `CF_DIB` (32-bit BGRA, bottom-up). Session 0 is a service.
  - Linux and other Unix: `wl-copy` with `WAYLAND_DISPLAY`, else `xclip`
    with `DISPLAY`; neither variable is headless, a missing tool is named.
    `WaitDelay` stops waiting on the forked child that serves the selection.
- `internal/httpapi/host_clipboard.go`: `GET /api/host/clipboard` (status
  and last write), `POST` (raw image body). Behind sign-in and the
  state-changing origin check like every other API route; it can only
  replace the clipboard, never read it.
- `web/clipboard-image.mjs`: the image in an image-only paste, clipboard
  items for the menu's Paste, `Ctrl+V` as `^V` or Kitty-encoded (with a
  release when flag 2 is on), the Diagnostics line.
- `web/app.js`: the paste bridge sends an image-only paste through
  `pasteImageIntoTerminal`; menu Paste falls back to
  `navigator.clipboard.read()` when `readText()` finds nothing; Settings →
  Diagnostics → Enhanced copy/paste, also in Copy diagnostics.
- README (copy and paste), CHANGELOG.

## Verification

- Go tests for parsing, Detect, the endpoint (stubbed clipboard), Linux tool
  selection and the Windows bitmap layout; node tests for the web module.
- `TESSERA_HOST_CLIPBOARD_TEST=1 go test ./internal/hostclipboard` writes the
  real pasteboard; `osascript -e 'clipboard info'` then lists `PNGf`.
- A local server answered `available` in the desktop session, put a POSTed
  PNG on the pasteboard, rejected text posed as an image (415) and a foreign
  origin (403).
- opencode 2.1.2 in a PTY, sent `^V` after the write, showed `[Image 1]`.
- Not yet: Cmd+V from iPadOS Safari (whether its paste event carries the
  image), Windows and Linux desktops on real hosts.

## Remaining

- Headless Linux: an in-memory clipboard behind stand-in `wl-paste`/`xclip`
  on the terminals' `PATH`. Deferred: opencode 2.x reads the clipboard with
  its own native code, which may not run those commands, so check what it
  does on Linux before building it.
- Optionally copy text pasted from the browser to the host clipboard too.
