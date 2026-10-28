# Changelog

## Unreleased

- RDP windows: **New RDP** (command palette `NR`, desktop menu or window
  type menu) opens a remote desktop to an existing RDP server, such as
  Windows Remote Desktop, through the Tessera host. Tessera shows the
  server's certificate for you to trust, warns if it later changes, and
  asks for the password each time without saving it. Fit, 1:1 and Resize
  scaling, Ctrl+Alt+Del and Windows-key buttons, and clipboard text in
  both directions are included. VNC windows are unchanged.

- RDP windows opened over HTTPS receive the remote desktop as H.264 video
  when the server sends it, decoded by the browser (in hardware on an iPad)
  and drawn straight onto the window; the toolbar shows **H.264** while it is
  in use. With Remotr on macOS, an iPad shows each frame about 3 ms after it
  arrives and needs much less bandwidth than with bitmap updates. Over plain
  HTTP, or with a server that doesn't send H.264, RDP windows use bitmap
  updates. RDP windows show the browser's own pointer shapes. Tessera bundles
  a patched build of IronRDP, the remote desktop client inside it, for this;
  `third_party/ironrdp/README.md` explains how to rebuild it.

- RDP windows can show H.264 in full color: when the server sends H.264
  4:4:4 (AVC444), check **Full color (4:4:4) when the server sends it** in
  the sign-in dialog and the browser combines it into full color with WebGL2,
  keeping colored text sharp; the toolbar shows **H.264 4:4:4**. Off by
  default, which shows the same stream at 4:2:0 as before. Remembered in the
  browser, and used for kept sessions too.

- RDP windows on a Retina or other high-resolution screen can be sharp: check
  **Sharp on this high-resolution screen** when signing in to get the desktop
  at the screen's own resolution, shown pixel for pixel, with the remote
  interface smaller. With **Keep the remote text full size** as well, Remotr
  lays out a Retina desktop so the interface keeps its size, within what
  Remotr allows (1920 pixels wide, 1920×1200 in all, 16:9), and falls back to
  the usual size if Remotr doesn't come back from the switch. About four times
  the bandwidth, so Sharp is off by default, for fast connections, and
  remembered in the browser; the full-size choice is remembered per window.

- Settings > Scroll wheel > Remote desktop sets how far wheel and two-finger
  scrolling move in RDP windows, from 0.1× to 2×, saved in this browser.
  Trackpad scrolling, which felt far too fast, can be turned down; slow
  scrolls still register at low speeds.

- Tab and Shift+Tab move through every field and button of the RDP and VNC
  sign-in dialogs and wrap around inside them, in every browser, instead of
  leaving the dialog for the toolbar behind it.

- The RDP sign-in dialog shows the server's address and port, each on its own
  line, under a "Sign in to RDP server" title (or "Rejoin RDP session"). The
  server is still changed in the window's address field.

- Browsers can save and fill RDP and Tessera logins with their password
  manager. The RDP sign-in fields are marked up for it, with the user name
  carried along when only the password is asked for. Chrome and Edge are
  offered an RDP login once it works, named "*user* — *server*", and a
  Tessera login made in the panel that appears when a sign-in ends, named
  "*name* — Tessera"; Tessera's login page already worked with password
  managers. Browsers keep logins per website, so every saved login lives
  under Tessera's address. Tessera itself still never stores a password.

- The README is now a short overview: what Tessera does, security, running,
  installing and a documentation index. The details moved, unchanged, into
  pages under `docs/`: terminal panes, workspace, browser pane, VNC and RDP
  panes, sign-in, remote access (iPad, phone view, Local HTTPS), deployment,
  and development and releases.

- RDP sessions can stay open on the Tessera host. With sign-in on, over HTTPS
  or loopback, check **Keep this session on the Tessera host** when you
  connect: closing the tab, reloading or switching workspace leaves the
  session logged in, and opening the window again, from any browser signed in
  to the same account, shows the desktop where you left it without asking for
  the password. The toolbar shows **On host**. If the connection to the server
  drops, Tessera asks only for the password and rejoins the same desktop
  session. **Disconnect** or closing the window ends the session, as does 8
  hours with no browser attached (`-rdp-idle-limit` changes this) or a
  Tessera restart. The server's own lock screen still applies, and the
  password is never stored. Clipboard text isn't available in kept sessions
  yet.

- The bundled IronRDP module that keeps RDP sessions on the host is built
  with its source paths remapped, so it contains none of the builder's local
  directories. `third_party/ironrdp/README.md` gives the build flags
  and a check for a rebuilt module.

- A new terminal window opens centered and half the size of the desktop
  each way (at least 360×220), from the command palette, a shortcut, the
  update prompt or the phone, and so do New Browser and New VNC from the
  command palette. New Terminal from the desktop's right-click menu still
  opens where you clicked, at the same size; browser windows opened from a
  terminal link and the right-click menu's browser and VNC windows open as
  before.

- Phone view: on a phone, Tessera lists the session's terminals instead of
  showing windows. Each card says what its shell is doing (running a
  command and for how long, at the prompt, a failed or finished command or
  a notification nobody has seen yet), with its folder, progress and last
  lines of output, and updates as they change. Tap a card to use that
  terminal full screen; its window keeps its place and size on the desk.
  **Desktop** switches this browser back to windows; `/m` or **Phone View**
  in the command palette switches it to the list.

- Phone input: under an open terminal, a compose field (with the phone's
  dictation and correction) sends text as one paste and then Enter, a row of
  keys a phone lacks (Esc, Tab, Ctrl, arrows, `^C` and more) sends them as a
  keyboard would, one-tap answers (`1` `2` `3` `y` `n` Enter Esc) appear when
  a program is waiting, and **☰** offers the terminal's recent commands and
  your snippets, which every device shares.

- Phone image attach: **📎** in the phone view, or pasting a screenshot into
  its compose field, keeps photos and images on the host and puts their
  paths in the field for programs such as Claude Code. **Paste as image
  instead** sends one to the program through the host's clipboard.

- The phone view no longer resizes the shell: terminals show at the size the
  desk gave them, as text rewrapped to the phone (the default) or as the
  screen in a font that fits its width. **Fit to this phone** in the **Aa**
  menu resizes the shell to the phone while it is open there, and the host
  gives the earlier size back afterwards, unless another browser resized it
  meanwhile.

- Command finished notices and the shell's reported command line end with
  … when the shell integration shortened the command (a second line, or past
  200 characters).

- Fixed: Browser panes loaded relative scripts, images and fetches against
  the site root on pages in a subfolder, sent relative redirects (such as Go's
  `./`) to the site root, and put pages whose `<head>` has attributes, or that
  have none, into quirks mode. A page that navigates from script to a
  root-relative path (`location.href = "/"`) or opens one with `window.open`
  now stays inside the proxy instead of showing a blank white pane. README →
  Browser pane limits lists what a proxied page can't do.

- Save Clipboard to File: a command palette dialog that saves the clipboard's
  text or images, or files pasted or dropped into it, to a folder on the
  host, with buttons for Home, Temp and the active terminal's folder. Delete
  Last Clipboard Save removes what it wrote, refusing any file that changed
  since.

- Image paste: pasting an image into a terminal (`Cmd+V`, or Paste in the
  terminal menu) puts it on the host's clipboard and sends the program
  `Ctrl+V`, so opencode and similar tools attach it, even from an iPad. It
  works on macOS, Windows and Linux desktops when Tessera runs in your
  desktop session; Settings → Diagnostics → Enhanced copy/paste says whether
  it is working, and detects a background service or a host with no display.

- Fixed: the release build's generated-files check failed on Zig's cache
  folder (`.zig-cache/`), which is now ignored, and two shell integration
  tests assumed Unix paths and permissions, failing on Windows.

- Shell integration: Tessera starts zsh and bash (4.4 or later) set up to
  mark prompts and commands (OSC 133) and report their directory (OSC 7), so
  prompt jumps, Copy Command Output and the window's directory work without
  editing `~/.zshrc`. Your own startup files still run. Settings → Terminal →
  Shell integration turns it off.

- Command finished notices: a command that ran for 5 seconds or more and
  finishes in a window you aren't looking at marks the window and shows a
  notice with the command, whether it failed, and how long it took.

- Find in a terminal's scrollback: `Cmd+F` (`Ctrl+Shift+F` off an Apple
  keyboard) opens a find bar that searches as you type, highlights every
  match, and moves between them with Enter and Shift+Enter, keeping up with
  new output.

- Releases build every generated file (terminal core, browser bundles,
  clipboard extension package) from source and build each platform's binary
  from them; a tag whose committed copies differ from the build fails.

- Underlines are drawn in their style (double, curly, dotted, dashed) and
  their own colour, such as Neovim's red curly underlines for errors and
  spelling, instead of all as one plain line in the text colour.

- Synchronized output (mode 2026): a program's redraw is painted whole
  instead of half drawn when it arrives in pieces, as over a slow
  connection. A redraw the program never ends is ended after a second, as
  in Ghostty.

- Capability and setting queries (XTGETTCAP and DECRQSS) are answered, so
  programs such as Neovim can find true colour and OSC 52 copying without
  guessing. Programs that enable in-band size reports (mode 2048) are told
  the pane's size after each resize.

- Kitty keyboard protocol: programs that turn it on (such as Neovim,
  Helix and fish) can tell Escape from Alt+key, Tab from Ctrl+I, and
  Shift+Enter from Enter, and get key releases and repeats if they ask.

- Fixed: on the iPad, switching between full-screen terminals could shift
  every window up (Safari scrolling the page to clear the keyboard's shortcut
  bar) until the bar was tapped. The workspace now stays put.

- Programs' progress reports (OSC 9;4) show as a bar along the window's
  title bar, red for an error and amber when paused, removed after 15
  seconds without a report.

- Programs can save and restore the window title (`CSI 22 t` / `CSI 23 t`),
  so a window goes back to its name when Vim (with `set title`) exits,
  instead of keeping "Thanks for flying Vim".

- Mode queries (DECRQM, DEC and ANSI) and the terminal version query
  (XTVERSION, answered `Tessera` and the version) are answered. Modes Tessera
  doesn't act on are reported as unrecognised.

- Fixed: binaries built since the screensaver was added left its module out,
  so the page failed to start unless Tessera was run with `-web` pointing at
  the source files.

- A terminal's bell and OSC 9 / OSC 777 notifications mark a window you
  aren't looking at, with a dot on its icon and `[bell]` or `[notification]`
  in window lists, until you show it. Notifications also appear in the
  page's corner (click to open the window), and as system notifications
  while Tessera is in the background if turned on in Settings → Terminal.
  Windows whose output is paused, and browsers that connect later, still
  hear of them.

- Programs that enable focus reports (mode 1004), such as Vim, Neovim and
  tmux, are told when a terminal gains and loses focus.

- Programs can ask whether a terminal is light or dark (`CSI ? 996 n`) and,
  with mode 2031, are told when it changes, so editors such as Neovim can
  follow the pane's light/dark setting.

- Programs can recolour a terminal: OSC 4/104 set and reset palette entries,
  OSC 10/11/12 the default foreground, background and cursor, OSC 17/19 the
  selection colours, and OSC 110–119 reset them. Queries (`?`) are answered,
  so themes like base16-shell, and vim and fzf checking the background, work.
  The colours survive reconnects and light/dark switches, and `reset` clears
  them.

- With a shell that marks its prompts (OSC 133), `Cmd+Up` and `Cmd+Down`
  jump between prompts in the scrollback (`Ctrl+Shift+Page Up`/`Page Down`
  off an Apple keyboard), and **Copy Command Output** in a terminal's context
  menu, or **Copy Last Command Output** in the palette, selects and copies
  what a command printed. The README has the zsh hooks.

- A terminal pane follows its shell's working directory when the shell
  reports it with OSC 7. The pane's directory field shows it, new terminals
  opened from the pane start there, and the shell starts there again after
  the host restarts. Only reports naming the Tessera host count, so `ssh`
  sessions don't move the pane. A pane whose directory has been deleted
  starts its shell in the host default instead of failing to open. zsh on
  macOS needs a `chpwd` hook to send OSC 7; the README has one.

- Programs can set the mouse pointer's shape over a terminal with OSC 22,
  such as a crosshair, a hand, or a resize arrow. Links still show the hand,
  and `reset` puts back the text pointer.

- A terminal link to `localhost` or `127.0.0.1` (or `::1`) opens in a Tessera
  Browser window instead of a new browser tab, since the address means the
  Tessera host and only a Browser window reaches it from another device. This
  covers OSC 8 links and addresses printed as text, such as a dev server's
  `http://localhost:5173/`. If a Browser window already shows that address,
  it comes forward instead.

- An address that wraps onto the next row opens whole from either row. Before,
  `Cmd`-click on the first row opened only the part on that row, and the rest
  was not a link.

- Programs that track all mouse motion (mode 1003) now see the pointer move
  when no button is held, so their hover effects work: underlining a button
  under the pointer, for example. Motion is reported once per cell. Hold
  `Shift` to keep the pointer for the terminal, as for clicks.

- OSC 8 hyperlinks work. Hovering over one shows its address along the bottom
  of the pane, since the link text can say anything, and `Cmd`-click or
  `Ctrl`-click opens it if it is an `http` or `https` link. Before, they were
  underlined but did nothing, and every link on screen was underlined as one.
  Hovering over any link now underlines it straight away instead of at the
  next output.

- `Globe+Left` and `Globe+Right` on an iPad keyboard send Home and End,
  and `Globe+Up`/`Globe+Down` send Page Up and Page Down. They had
  reached the shell as `Command`+arrow, so zsh typed `9D` instead of moving
  to the start of the line.

- Music streamed into a terminal (Trinity, for example) no longer stops
  briefly when you bring that terminal back into view after another window
  covered it, it was minimized, or its browser tab was hidden. A terminal
  playing a stream keeps receiving output while hidden, like an audible
  browser tab, instead of reconnecting when shown.

- The terminal audio docs explain where stream quality comes from: the
  producer's Opus bitrate, which `tessera-audio stream` lets you raise to
  256 kbps for local use.

- Add a **Screensaver** to the command palette: a full-screen mosaic of
  slowly shifting tiles with a tile clock that drifts around the screen.
  Mirrored katakana rain falls through the tiles and paints the screen in
  when it opens. It falls lightly in most palettes and heavily in a green
  phosphor one, where the clock turns pale green. Now and then a band of
  tiles glitches. Any key, click, tap or mouse movement returns to the
  workspace. It doesn't lock anything.

- `Ctrl+Backspace` / `Cmd+Backspace` no longer destroys the active window,
  which was easy to do by accident. Use **Destroy Window** in the command
  palette (`Ctrl+K`/`Cmd+K`, then `DD` or `close`).

- Fewer stray mouse reports at the shell prompt after quitting a mouse-aware
  program (text like `32;5;5M0;5;5m`). A drag is now reported once per
  cell, as in xterm, rather than on every pointer movement, and the server
  passes drags only to programs that asked for them (mouse modes 1002 or
  1003), not to ones that want only clicks.

- `apple/build-ipa.sh` builds an unsigned `Tessera.ipa` that SideStore or
  AltStore can sign and install on an iPad, for installing away from the Mac
  (Xcode can't reach an iPad over Tailscale).

- Start a native iPad and Mac app in `apple/`: a SwiftUI window around the
  Tessera web client from a server you choose. It asks for the address on
  first launch, shows the page's confirmations as native dialogs, saves
  downloads to Downloads (Mac) or the Files app (iPad), opens other sites in
  the system browser, and allows plain HTTP. Built from Xcode; not part of
  releases yet. Settings → Diagnostics names it `Tessera app`.

- On macOS and iPadOS, `Cmd+Left` and `Cmd+Right` in a terminal send Home
  and End, for keyboards without those keys such as the iPad Magic
  Keyboard. Ctrl and Option arrows are unchanged. zsh needs Home and End
  bound to use them at the prompt; see the README.

- Add a key test to Settings → Diagnostics. Press keys in its field to see
  what the browser reports for each one (key, code, modifiers, and the edit
  a delete would make); **Copy key log** copies the list. It shows which
  combinations reach Tessera on keyboards without Home, End or forward
  Delete, such as the iPad Magic Keyboard.

- Typing prediction is quieter. Predicted characters now look like ordinary
  text, since a quick echo replaces them within a frame or two; they are
  underlined only while echoes take over 80 ms, or after a wrong or slow
  guess until later echoes come back quickly. The cursor also stays solid
  while you type instead of flickering with each key, and starts blinking
  again once you stop.

- Typing prediction now covers Left and Right and editing mid-line. Moving
  the cursor, typing into the middle of a line and Backspace there show at
  once, with the rest of the line shifted, so fixing a typo in a long command
  no longer waits for the round trip. Moves never enter the prompt.

- Make typing prediction cheaper per keystroke. Checking a prediction read the
  whole visible screen out of the terminal engine twice per key, about 5 ms
  on an iPad after each echo and again before the key was sent; it now reads
  only the cells it compares. Settings → Diagnostics now splits recent echoes
  into time before sending, until the reply is handled, and applying.

- Add typing prediction for slow connections. Typed characters appear at
  once, lightly underlined until the server's echo confirms them, instead of
  after a full round trip. **Auto** (default, under Settings → Terminal)
  turns on once echoes take over 20 ms. Backspace is predicted too: it
  withdraws a still-predicted character, or erases echoed text at the end of
  the line. Settings → Diagnostics shows whether it is drawing and the
  measured echo time. Nothing is shown where the program
  does not echo, such as password prompts, and the terminal's contents are
  never changed by a prediction.

- **Tessera now refuses requests addressed to unrecognized DNS names** (`421`),
  blocking DNS-rebinding attacks. This applies with sign-in off too. IP
  addresses, `localhost`, the machine's own name, and the Local HTTPS
  certificate's names keep working; add any other name you use, such as a
  Tailscale MagicDNS or reverse-proxy name, with `-allowed-host`. Refused names
  are logged once with the flag to add.
- When a sign-in ends, open terminal and VNC connections close and the
  workspace shows a sign-in dialog instead of leaving the page; signing in
  reconnects the same terminals and retries pending saves. Add **Settings →
  Signed-in devices** with per-device Sign Out and Sign Out Everywhere. With
  `-audit-log`, sign-in events are recorded with the sign-in's ID.

- Add `-auth=system`: sign in with the password of the account Tessera runs
  as, checked without cgo (OpenDirectory through purego on macOS, PAM's
  `unix_chkpwd` on Linux, `LogonUserW` on Windows). Add `tessera login`, which
  prints a one-time sign-in link valid for two minutes, and `tessera logout
  -all`, which ends every sign-in; both work only on the host, using a private
  recovery token kept beside the credentials file.

- Add optional sign-in. Start the server with `-auth=file` to require a
  password; accounts live in a private credentials file of argon2id hashes,
  managed with `tessera user add|passwd|remove|list` and picked up without a
  restart. Each account signs into its own workspaces (an account named after
  an earlier `-users` entry, or `default`, keeps those workspaces). Sign-ins
  use an `HttpOnly`, `SameSite=Strict` cookie, last 12 hours idle (30 days
  when remembered), end when the account's password changes, and are slowed
  after repeated failures. Passwords over plain HTTP from other devices need
  `-allow-http-sign-in`. **Sign out** is in the desktop menu and command
  palette. Sign-in stays off by default, so existing installs are unchanged.

- Show keystroke echoes and other small output in the active terminal without
  occasionally waiting an extra frame (about 5% of keystrokes measured in
  Chrome, now none). The active pane now applies small output as it arrives
  instead of after a posted task; other panes and large output keep the
  shared, budgeted queue.

- Cache the web app's scripts for good between page loads. Module imports now
  carry the build hash, and assets requested at the current hash are served
  immutable, so reopening Tessera no longer revalidates every module; any
  server update changes the hash. Assets served from a `-web` directory still
  revalidate.

- Stop a backgrounded page from resizing its shells. iPadOS resizes a
  home-screen web app while showing the app switcher, and that size reached
  running programs, leaving output such as Homebrew logs misaligned after
  switching back.

- Compress large terminal output frames over the websocket
  (permessage-deflate at best speed, frames of 1 KiB or more), cutting
  bandwidth for bulk output and full-screen redraws by about 6-8x. Terminal
  input no longer waits for the server to finish parsing output.
- Verify self-update downloads against GitHub's published SHA-256 digest and
  bound their size. Keep Browser pane pages sandboxed when opened outside the
  pane. Reject bare IPv6 VNC targets, which Go 1.26 misparsed; bracket them.

- Trigger the CI and Release workflow only on `v*` tag pushes; branch
  pushes, pull requests and manual dispatch no longer run CI. The daily
  artifact cleanup keeps its schedule.
- Remove the Tessera Desktop macOS preview app (`cmd/tessera-desktop`,
  `internal/nativeapp`), its build script and workflow, and the server's
  desktop-only request policy. The webserver is the only application target.

- Stop animated application titles (such as Claude Code's spinner) from
  saving the workspace on every frame and rebuilding open window lists; they
  now relabel those lists in place. Give a shared terminal's size to the
  browser in use: typing or clicking reclaims it, and a browser joining a
  terminal another is showing no longer resizes it. Refitting maximized panes
  to a changed viewport no longer saves, so devices stop overwriting each
  other's sizes and colliding in save conflicts.
  Add a Refresh Terminal Size palette command that refits every terminal on
  screen and gives their shells this browser's size without reloading.

- Follow terminal application window titles from OSC 0/2 in title tabs and
  window lists. Retain titles in the shared terminal core and snapshots so
  byte-stream fragmentation, refreshes, and hidden-pane recovery preserve them.
  Protect active title edits and ignore empty or oversized title requests.

- Remove the audio and file OSC CLI programs and their release assets from this
  repository now that they are maintained independently. Keep terminal protocol
  support and documentation; smoke checks accept external helper binaries.

- Apply each returning user's cached theme before the first paint and restore
  sessions behind a startup visibility gate. Reveal terminal snapshots and
  keyboard focus together, defer optional prompts, and provide delayed loading
  feedback with reload recovery for failed or stalled startup.

- Smooth terminal wheel and trackpad scrolling at every wheel speed, with
  accumulated gestures, responsive reversal, pixel-level row movement, and
  synchronized scrollbar fades. Preserve the history view during live output,
  resume following output on typing, and respect reduced motion.

- Add per-terminal Dark/Light color choices to the terminal and window menus,
  with a Use default option. Persist choices in sessions with migration 048;
  user default changes affect only inheriting terminals. Color changes keep
  the managed shell running and restore its retained output.

- Run platform CI on main pushes, pull requests and manual dispatch; retain
  version-tag publishing for Tessera on Windows amd64, macOS arm64 and Linux
  amd64/arm64. Test every target and reject missing/empty release binaries
  before publishing.

- Add per-user terminal shortcuts with a management modal, ordered optional or
  required invocation inputs, CLI switches, defaults, duplicate/delete/test actions,
  and custom palette/Command Wheel codes. Launch in a new terminal with host shell
  quoting and directory validation; restored panes never rerun commands. Migration
  047 persists definitions with independent revisions for concurrent-save conflicts.

- Retire Text Editor and Worksheet panes, CodeMirror/syntax bundles, worksheet
  command runs, raw file-content APIs, and editor-scroll settings. Migration 046
  converts legacy panes to terminals while preserving layouts and archived text,
  tabs, paths and modes. Imported panes receive the same conversion; ordinary
  workspace saves retain archived documents without executing their contents.

- Add host-local terminal file transfers: browser
  batch uploads, original-file or streamed ZIP downloads, transient live claims,
  scoped tickets, cancellation and progress. Retire File Browser panes; migration
  045 preserves their IDs, layout and directories as terminals.

- Preserve verified legacy companion release assets so pre-v1.9.1 updaters can
  upgrade after the Audio station retirement. Tessera still updates only its
  own executable and does not use or build LAME.

- Disable browser autofill and writing suggestions in the command palette input.

- Retire the standalone Audio pane, shared station API/state, process capture,
  and bundled LAME encoder. Migration 044 removes legacy Audio panes while
  preserving other workspace content and invalidating affected stale saves.
  Releases, self-updates, and the Ubuntu installer no longer manage LAME.
  Terminal clips, Opus streaming and local controls remain.

- Stream terminal audio incrementally from files/stdin through FFmpeg's Opus
  encoder. Add configurable bitrate and 100–2000 ms buffering, live joining
  after enable/unmute/reconnect, bounded browser decoding, and stream payload
  exclusion from terminal history and snapshots. Existing clips remain v1.

- Hold the middle mouse button and drag to draw a new window over existing
  panes, including sandboxed Browser content. Preserve normal left clicks,
  ignore simple middle clicks, and discard canceled outlines.

- Double-left-click window title bars to maximize or restore them. Keep title
  renaming and title-bar control buttons separate from this gesture.

- Add Terminal row spacing settings with Tight as the default and Comfortable
  for extra room above and below text. Save the choice per user and refit open
  terminals immediately while preserving accents, descenders, and box borders.

- Draw solid terminal box borders to the cell edges so vertical lines and
  corners stay connected across text rows, including with IBM Plex Mono.
  Preserve ordinary text spacing and faint border opacity.

- Remove window decorations from maximized Operator panes, matching OLED
  Terminal. Reclaim the title-bar space and retain shortcut and command-palette
  restore actions.

- Add a private terminal audio protocol for embedded
  WAV/MP3 clips, capability discovery, and stop commands. Enabled browser clients
  mix live sounds independently with per-terminal mute, including hidden panes;
  reconnect and terminal history never replay sounds. Bound decoding, memory,
  overlap, and listener queues without interrupting terminal text or shells.

- Synchronize the subscriber-disconnect persistence test with actual command
  startup and gated output. Verify the full transcript from a reopened database
  and distinguish startup timeouts from command-completion failures.

- Treat Linux PTY hangups as end-of-stream and use the shell's process result
  for exit notices. Clean exits now close paused terminal connections normally,
  while nonzero process exits retain their failure status.

- Fix a macOS shutdown-test startup race by waiting until its long-lived command
  child has started before cancelling both workspace runs.

- Document unresolved Windows Chrome terminal graphics stalls and rare canvas
  corruption, including tested scope, recovery guidance, and investigation
  results. Refresh README terminal behavior, validation instructions, and Local
  HTTPS support.

- Recover terminal canvases after browser graphics context loss. Preserve output
  while graphics are unavailable, restore the drawing state, recreate image
  bitmaps, and repaint retained content in both terminal renderers.

- Skip retained-image cleanup after writes that cannot change image attachments,
  while reclaiming overwritten and evicted images immediately. Read only needed
  native rows for small terminal paints, retaining one bulk read for full paints.
  Create browser image bitmaps when their visible fragments are painted, avoiding
  eager pixel copies for images retained in history or on the alternate screen.

- Fix native terminal crashes during sustained combining-character and
  Devanagari output by clearing reused memory before growing terminal pages.
  Preserve graphemes across scrolling, history eviction, reflow, and snapshots.
- Clear initial and pooled terminal page memory as well, fixing native crashes
  after repeatedly closing and opening terminals with image and Unicode output.
- Grow Sixel raster width and height independently. Dense 1024x720 images now
  fit the configured budget instead of wasting width and being rejected; keep
  transient-copy accounting and decoded-image limits enforced.

- Reuse a bounded browser terminal WASM input buffer across output, reset, and
  snapshot restore; release temporary oversized writes and retained memory on
  disposal. Align terminal rectangles, images, damage clips, and decorations to
  physical pixels, allowing incremental paints at fractional display scaling.
  Round canvas size allocation and comparisons consistently for odd grids.

- Disable browser writing suggestions and spellchecking on terminal input
  surfaces, preventing Edge's writing-assistance marker from appearing over
  terminal windows. Disable writing suggestions on window title fields too.

- Add the Operator theme with charcoal surfaces, mint active-window glow,
  compact title bars, dotted grips, and minimize/maximize/restore/close controls.
  Keep the title bar accessible when maximized, use unsuffixed names for new
  Operator panes, and confirm closing live shells. Optional browser-local
  window wobble adds bounded tilt/stretch during drag without resizing terminal
  content; reduced motion and Older Mac mode disable it.

- Read and decode each terminal viewport at most once per paint, sharing it
  across text, selection, hover, cursor, and image rows. Keep subsequent frames
  fresh, preserve independent row copies, and avoid eager reads for idle or
  history-only frames.

- Preserve incremental terminal painting while Sixel images are visible. Redraw
  fragments only in repainted rows, protect neighboring glyph edges, and keep
  transparency, selection, cursor, scrollbar, and recovery layering intact.

- Catch up small terminal visibility and reconnect gaps through ordered replay,
  capped at 64 KiB and 128 events. Keep snapshots for larger gaps, overflow, and
  interrupted imports; preserve hidden delivery pauses and clipboard suppression.

- Reuse host terminal WASM input and response buffers across PTY reads. Bound
  retained input space, release oversized temporary writes and all buffers on
  close, and preserve complete query replies and clipboard effects.

- Pause server delivery to hidden terminal connections, clear their output
  queues, and preserve shell-exit notices and visible clients. Initially hidden
  panes skip snapshot transfer; revealing restores changed state from a fresh
  snapshot while idle panes preserve their selection and scroll position.

- Reuse each browser terminal's 4 KiB clipboard cleanup buffer across writes,
  resets, and snapshot restores. Release it on disposal and preserve complete
  clipboard draining and host-only query replies.

- Restore dirty-row terminal painting when retained Sixel images are offscreen.
  Clear old image pixels with one full redraw when the last visible fragment
  disappears, and preserve visible-image layering, cache cleanup, and scrolling.

- Share an approximately 6 ms terminal painting budget per animation frame.
  Prioritize the active pane, rotate other ready panes, and preserve deferred
  redraws. Keep background panes progressing when an active paint uses a whole
  frame, while preserving FPS limits, typing responsiveness, and visibility.

- Prioritize the active visible terminal within the shared parsing budget.
  Give it three events per visit while other busy panes get one, transfer
  priority on focus changes, and keep background builds progressing across
  costly events and frequent small updates.

- Share a 64 KiB / approximately 5 ms browser parsing turn across terminals.
  Count live output bytes, rotate complete events fairly between busy panes,
  and yield through posted tasks without nested-timer delays. Preserve each
  pane's event ordering and independent pause, reconnect, and cleanup.

- Suspend browser parsing for minimized, fully covered, and background-tab
  terminals. Discard pending output and restore the latest host snapshot on
  reveal while shells keep running and shell-exit notices stay connected.

- Speed up terminal output with retained Sixel images by skipping text-only
  pages during image cleanup. Preserve image attachments across page copies,
  reflow, snapshots, erasure, and history eviction.

- Default to the Standard performance profile, Experimental terminal renderer,
  paint coalescing on, and server output coalescing off. Preserve saved browser
  preferences, including an explicit Stable renderer selection.

- Correct terminal text sitting too high in editors such as Fresh. Use full
  font ascent and descent for the shared cell metrics, with room for accents
  and descenders and a compatible measurement fallback for older browsers.

- Prevent Safari Control-click on terminal hyperlinks from selecting the whole
  canvas or leaving a local drag latched. Keep macOS Control-click contextual
  and Command-click for links. Recover interrupted selections, stop autoscroll,
  and redraw selection changes even with idle output and cursor blinking off.

- Run palette commands only with Enter or a click. Put exact shortcut matches
  first and let arrow or pointer selection control what Enter runs. Add
  preferences, rename, and close search aliases; wheel shortcuts stay immediate.

- Name the session manager Tessera Sessions in the palette and Command Wheel,
  with code TS. Searching se highlights Settings before other prefix matches.

- Change the Settings command code to S in both the palette and Command Wheel.
  Typing S or clicking Settings in the wheel opens it directly; the palette
  uses S then Enter.

- Add an experimental game-style Command Wheel on Ctrl/Cmd+; and the workspace
  menu. Translucent radial wedges highlight the selected group in gold and
  reveal valid second keys in an outer arc. Support hover, keyboard, touch,
  and palette search.
  Ctrl/Cmd+K continues to open the searchable command palette.

- Drag Window List rows by their grip or name to reorder them, with an insertion
  indicator and one save per changed drop. Preserve minimized state and window
  contents; canceled and unchanged drops keep the current order.

- Add per-session window reordering with Ctrl/Cmd+Shift+Up/Down and Up/Down row
  buttons in Window List. Use a stable saved order across cycling and window
  menus, preserve row focus while moving, and contain keyboard focus in the list.

- Lead Settings with everyday preferences and move technical terminal controls
  into collapsed Advanced and Diagnostics sections. Contain Tab and Shift+Tab,
  preserve focus and scroll across redraws, and restore focus after dismissal.
  Run live diagnostic checks and rendering measurements only while expanded.

- Bound each browser terminal's unapplied output queue and catch up from an
  authoritative snapshot on overflow without restarting the shell. Add a
  device-local Terminal output backlog control under Advanced → Performance
  with Auto (normally 4 MiB), 8, 16, and 32 MiB choices. Apply changes to open
  terminals immediately and back off repeated overload recovery attempts.

- Show a brief text-size percentage in the active pane after Ctrl/Cmd+Plus,
  Ctrl/Cmd+Minus, or Ctrl/Cmd+0, using the configured default size as 100%.
  Accept the shifted Plus key as well as unshifted and numpad shortcuts.

- Store the Older Mac performance profile per browser so its 30 FPS cap does
  not follow the same Tessera user to newer computers.
- Restore Ghostty's terminal renderer by default and make the uniform
  plain-row fast path an optional per-browser experimental renderer.
- Extend the experimental renderer to mixed ANSI text colors and merged runs
  of colored cell backgrounds.
- Keep simple cells on the experimental fast path in rows that also contain
  styled or Unicode cells, and report fast, hybrid, and original row rates in
  Compatibility diagnostics.
- Restore terminal animation throughput by sampling paint costs only while
  Settings is open and limiting cursor-row invalidation to actual blink frames.
- Keep the High Sierra symbol fallback out of the ordinary text canvas path,
  bypassing all symbol geometry work for ordinary cells and applying the
  fallback only to symbols so frequent ANSI color updates stay smooth.
- Add a 10-second terminal output timing capture to Compatibility diagnostics.
  It follows each output event from host PTY read through WebSocket delivery
  to browser paint, and reports split or partially painted synchronized
  updates, without comparing host and browser clocks.
- Add per-browser Paint coalescing and Server output coalescing toggles under
  Settings → Performance. Paint coalescing is on by default and waits briefly
  for streaming output to pause so split animation frames are painted whole.
  Server coalescing is off by default: it joins closely spaced output into
  fewer WebSocket messages, but on lossy links larger messages caused longer
  delivery stalls.

- Reduce painting overhead for plain ASCII terminal rows by setting canvas font
  and foreground once per row while preserving fixed cell positions.

- Stabilize the 30 FPS terminal cap with anchored animation-frame deadlines,
  avoiding dropped frames caused by small callback timing variations.

- Slow hidden-tab health polling to every 30 seconds and refresh immediately
  on return. Skip hidden countdown/spinner updates and use steady worksheet
  spinners in Older Mac mode.

- Show rolling five-second FPS and painting costs in Compatibility and copied
  diagnostics. Measurements update once per second while Settings is visible.

- Cap terminal painting at 30 FPS in Older Mac mode with a brief input bypass.
  Show per-terminal frame counts and CPU painting costs in Compatibility and
  copied diagnostics.

- Pause painting and cursor blinking in terminals fully covered by another
  window, and fully repaint them when exposed. Output continues processing.

- Add Repair Terminal View (RV) to the command bar for the active terminal,
  forcing a fresh fit and full repaint without restarting the shell.

- Preserve a terminal's final fit request when rapid layout changes overlap
  the fit add-on's resize guard, preventing an intermediate grid from leaving
  content cropped until minimize, maximize, or refresh. Visible terminals also
  remeasure after tab visibility and sleep recovery.

- Add a live Compatibility panel under Settings showing native clipboard
  support, Firefox extension connection and terminal permission, effective
  rendering scale, performance profile, and server connection state. A Copy
  diagnostics action uses Tessera's clipboard bridge and browser fallbacks.

- Add a per-user Older Mac performance preset that caps terminal canvases at
  1× resolution, uses a steady cursor, disables terminal smooth scrolling, and
  stops decorative status animations. Changes apply to open terminals without
  reconnecting them.

- Detect macOS sleep and reconnect terminal streams from their last replicated
  position after wake, force a complete terminal repaint, and show a compact
  recovery status until the server and affected terminals are ready.

- Prompt Firefox 115 ESR users to set up Tessera's clipboard extension when
  its bridge is missing, with direct Clipboard settings guidance and a one-day
  reminder snooze. Newer Firefox is prompted only when native clipboard access
  is unavailable on the current connection.

- Hide Firefox's native contenteditable caret in Terminal panes and repaint
  Ghostty's canvas cursor row on each Tessera-managed blink frame.

- Redraw every terminal row after a host geometry update clears its canvas,
  preventing an idle TUI from remaining blank after a Firefox page refresh.

- Render terminal technical, geometric, dingbat, arrow, and Braille symbols
  through a bundled Noto Sans Symbols 2 fallback, fixing overlapped glyphs such
  as Claude Code's `⏵⏵` indicator in Firefox 115 on macOS High Sierra.

- Add an optional Firefox 115 clipboard extension with per-address consent,
  separately enabled terminal writes, editor/terminal/VNC integration, and
  embedded download/setup controls under Settings → Clipboard.

- Add persistent VNC connector windows using bundled noVNC, manual in-memory
  authentication, explicit clipboard transfer, view-only and scaling controls,
  and short-lived same-origin WebSocket-to-TCP capabilities for any host target.

- Add shared per-terminal Sixel memory budgets (16/32/64 MiB), optional
  discarded-image markers, and an action to clear images while keeping text.

- Add Sixel images with native Ghostty cell attachments, canvas rendering, and
  shared host/browser WASM state. Ordered reconnect snapshots restore retained
  text and images beyond the raw replay window, with host-owned terminal replies
  and live-only clipboard effects. Bundle modern ConPTY passthrough on Windows.

- Add a right-aligned file-size column to the pane File Browser, with compact
  IEC units, blank folder sizes, and resilient unavailable metadata handling.
- Show a centered, Alt+Tab-style window switcher while `Ctrl+[` or `Ctrl+]`
  cycles through visible windows, including their order and the active title.
- Run Ubuntu service installations as the non-root user that invoked `sudo`,
  with that user's home-directory access and existing `sudo` permissions,
  instead of creating an isolated `tessera` system account.
- Let the Ubuntu installer choose between the safe `127.0.0.1` default and
  listening on every interface at `0.0.0.0`; non-interactive installs retain
  the localhost default.
- Let the Ubuntu installer optionally download the matching pinned LAME MP3
  encoder with `--with-lame` or an interactive prompt, while skipping it by
  default and preserving any existing companion when omitted.
- Fix `Ctrl+V` in a Terminal pane on macOS, where it reached neither the
  clipboard nor the application. It now arrives as `^V`, so a full-screen
  program that binds paste to `^V` receives it, matching Terminal.app. `Cmd+V`
  still pastes through the browser's paste event.
- Keep macOS `Cmd+V` from leaking a literal `v` into raw-mode terminal programs
  such as Claude Code. Tessera now stops that keydown before terminal input
  handlers see it without cancelling Chrome's trusted paste event; Windows and
  Linux `Ctrl+V` retain their existing path.
- Stop `Cmd`+letter typing its bare character into a Terminal pane on macOS.
  `Cmd+S` in a TUI editor inserted an `s` into the document instead of doing
  nothing; Command is a menu accelerator, and those keystrokes are now consumed.
- Stop losing an OSC 52 copy behind a browser clipboard permission prompt.
  Chrome leaves `clipboard.writeText()` pending — neither resolved nor rejected
  — until the prompt is answered, and a copy from a full-screen program arrives
  over the terminal socket with no keystroke attached, so it raises one. Tessera
  waited on that forever: the copy vanished with no error, and every later
  terminal copy queued behind it was never attempted. Writes now give up after
  1.5 seconds and take the fallback path, which lands the copy on the system
  clipboard without the prompt being answered at all, or reports "Clipboard
  blocked" when it cannot.
- Report "Nothing to copy" when a terminal copy finds no selection, instead of
  consuming the keystroke and doing nothing. Inside a mouse-aware program the
  message names both ways to copy there — hold `Shift` while dragging to select
  on the terminal's own layer, or use the program's own copy key. It clears
  itself after a few seconds, since nothing is broken and nothing needs
  answering. The Shift override is now documented in the README as well.
- Paste into a Terminal pane as a paste rather than as typing: the browser's
  paste event is now handled by Tessera and applied through the terminal, so
  applications that enabled bracketed paste receive the text bracketed and can
  undo a paste in one step. Bracketed paste markers inside the pasted text are
  removed.
- Copy out of a full-screen terminal program: OSC 52 clipboard writes are
  filtered out of the terminal stream and put on the system clipboard, so a copy
  inside a TUI editor can be pasted into other applications. Clipboard read
  requests are swallowed rather than answered.
- Fix pasting from another application into a Terminal pane: the platform's
  paste key is left to the browser's paste event, which ghostty-web reads
  without needing clipboard permission, instead of being consumed in favour of a
  clipboard read that browsers can deny.
- Report "Clipboard blocked" when a paste falls back to Tessera's own last copy,
  rather than silently pasting stale text.
- Coalesce terminal fits into one per frame while a pane is dragged or resized,
  and send the terminal's grid size only when it actually changes, instead of a
  `resize` frame per pointer move.
- Keep resize-heavy full-screen programs from stalling the Tessera page. The
  browser terminal still fits live while geometry changes, but the PTY now gets
  one final grid size after the layout settles instead of redrawing the program
  for every transient size; initial connections and reconnects remain immediate.
- Keep verbose commands such as parallel builds from monopolizing the browser
  thread. Terminal output is now parsed in ordered, bounded turns with regular
  yields for input, layout, and painting; large reconnect replays are split into
  small writes instead of entering Ghostty's synchronous parser all at once.
- Skip resending pane documents on workspace saves that did not change them, so
  moving a window no longer rewrites every open editor buffer.
- Give the Window List keyboard focus when it is opened from the command
  palette, so its arrow keys select rows instead of reaching the focused
  Terminal pane.
- Relay window-management shortcuts (`Ctrl+[`/`Ctrl+]` cycling, `Ctrl+K`,
  `Ctrl+L`, `Alt+F7`/`F9`/`F10`) out of Browser panes, so they still work while
  the embedded page holds keyboard focus.
- Add an Update action to the Windows and macOS tray menu with checking,
  up-to-date, failure/retry, and restarting states wired to the verified
  self-update lifecycle.
- Make Update Server service-aware on Ubuntu systemd installations. Tessera
  opens a foreground Terminal for interactive `sudo`, runs its existing
  transactional updater in a separate transient systemd unit, preserves the
  installed unit and listen address, restarts `tessera.service`, and reloads
  only after the expected version is healthy. The unprivileged HTTP process no
  longer attempts to replace the root-owned service executable directly.
- Keep the visually active window synchronized with real keyboard focus across
  every pane type, window navigation, drag/resize activation, and palette or
  window-list dismissal.
- Avoid redundant workspace saves when clicking an already-active, frontmost
  pane while still persisting real active-pane and stacking-order changes.
- Keep the old self-update process alive until a detached replacement confirms
  its server started, and report successor startup failures through the
  handoff instead of silently exiting after process creation. Run this handoff
  independently of the macOS tray event loop, which may not return after
  removing its tray item.
- Normalize Safari's context-menu-only macOS secondary clicks into one complete
  right-click for mouse-aware Terminal apps, while preventing latched
  ghostty-web selection without reserving right-click or removing an existing
  local selection.
- Always pair forwarded Terminal mouse presses with releases, including when a
  TUI changes mouse mode or macOS interrupts a secondary click with a context
  menu, preventing applications such as Fresh from remaining visually latched.
- Preserve Terminal selections when opening the context menu and support
  `Cmd+C`/`Cmd+V`, `Ctrl+Shift+C`/`Ctrl+Shift+V`, and `Shift+Insert` clipboard
  shortcuts without intercepting terminal `Ctrl+C`.
- Reconnect unexpectedly closed Terminal WebSockets with capped backoff,
  independently from the server-health recovery dialog.

- Add independent per-user Terminal and editor wheel sensitivity controls,
  applied immediately across terminal scrollback/TUI input and Worksheet/Text
  Editor scrolling.
- Make self-update recovery wait for the expected new server version, tolerate
  a dropped restart acknowledgement, and restore the reconnect modal instead
  of leaving the browser client locked in a stale restarting state.
- Fix LAME 3.100's native MinGW `langinfo.h` regression with the historical
  MSYS2 source patch and an executable version check in the release job.
- Stabilize the Windows run-manager persistence test by waiting on the run's
  completion signal with adequate shared-runner process-startup headroom.
- Dismiss the File Browser upload progress row shortly after successful
  completion while keeping failed-transfer summaries visible.
- Add streamed multi-file upload, drag-and-drop progress, overwrite
  confirmation, and range-capable attachment downloads to File Browser panes.
- Log each distinct web client to stdout once per server process using its
  resolved IP and a short process-salted fingerprint.
- Add a global server-connection monitor and accessible recovery modal with
  Reconnect, Refresh Page, offline detection, and user-confirmed reload after
  background recovery; intentional self-update restarts remain suppressed.
- Add same-origin protection for browser mutations and Terminal WebSockets
  while retaining localhost, literal-IP intranet, and origin-less local-client
  access.
- Add opt-in immediate-proxy trust with strict single-hop `Forwarded` and
  `X-Forwarded-*` validation.
- Add CSP and related security response headers, HTTPS-only conservative HSTS,
  bounded per-client API rate limiting, request IDs, and opt-in redacted SQLite
  audit events with configurable retention.
- Permit WebAssembly compilation required by the bundled Terminal renderer in
  CSP and loading its embedded WASM data URL without enabling general
  JavaScript evaluation or external connection targets.
- Add one persisted host-wide Audio station with shared file, direct HTTP(S),
  and linked-Terminal sources.
- Add versioned audio state/control/stream APIs, immediate SSE snapshots, local
  file ranges, cancellable URL proxies, and terminal MP3 fan-out.
- Expose live PTY process IDs and stop linked capture when its Terminal closes.
- Supervise the external capture-helper protocol and a 192 kbps LAME encoder,
  including readiness timeouts, bounded listener queues, soft capability
  failures, and graceful/forced process shutdown.
- Add the Audio pane, `New Audio` command (`NA`), global transport controls,
  browser-local volume/mute, seeking, terminal linking, and autoplay recovery.
- Extend releases and self-update with pinned LAME 3.100 companion assets,
  license/source publication, transactional rollback, and legacy companion
  bootstrap.
