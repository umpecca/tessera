# Changelog

## Unreleased

- Fix `Ctrl+V` in a Terminal pane on macOS, where it reached neither the
  clipboard nor the application. It now arrives as `^V`, so a full-screen
  program that binds paste to `^V` receives it, matching Terminal.app. `Cmd+V`
  still pastes through the browser's paste event.
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
