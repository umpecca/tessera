# Changelog

## Unreleased

- Disable browser autofill and writing suggestions in the command palette input.

- Retire the standalone Audio pane, shared station API/state, process capture,
  and bundled LAME encoder. Migration 044 removes legacy Audio panes while
  preserving other workspace content and invalidating affected stale saves.
  Releases, self-updates, and the Ubuntu installer no longer manage LAME.
  Terminal clips, Opus streaming, local controls, and the FFmpeg helper remain.

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

- Add a private terminal audio protocol and `tessera-audio` helper for embedded
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
