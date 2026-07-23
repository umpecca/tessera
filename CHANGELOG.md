# Changelog

## Unreleased

- Keep the old self-update process alive until a detached replacement confirms
  its server started, and report successor startup failures through the
  handoff instead of silently exiting after process creation.
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
