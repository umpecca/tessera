# Terminal panes

Terminal panes run a persistent shell on the Tessera host: ConPTY on Windows, a Unix PTY on macOS and Linux. Sessions keep bounded scrollback while the server runs, and restore their text and images when a browser reconnects.

## Features

Terminal panes support Sixel images and restore retained text and images from
the running host when a browser reconnects. Right-click a terminal to choose an
image-memory budget, toggle discarded-image markers, or clear images while
keeping text. See [terminal core documentation](terminal-core.md)
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
startup file. If you added the hooks from earlier Tessera versions to
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
bitrate and buffering. Both mix with local per-terminal mute. See [terminal audio](terminal-audio.md)
for the private escape-sequence protocol. The audio and file CLI programs are
maintained and released in an independent repository.

## Copy, paste and links

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

## Typing prediction

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

## Appearance

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

Solid Unicode block elements are drawn as pixel-aligned cell geometry instead
of font glyphs. This keeps fractional blocks and quadrant art joined without
the seams that browser font rasterization can introduce. Shade characters
remain font-rendered.

## Output backlog and painting

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
corruption remain [known issues](known-issues.md).

## Performance settings

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

## Launch shortcuts

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

## File transfers

Terminal applications can use the [file transfer protocol](terminal-files.md)
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
