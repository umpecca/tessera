# Task 227: Command finished notices

Status: complete (iPad check pending)

## Request

Tell people when a long command finishes in a window they aren't looking
at, building on the alerts of task 215 and the prompt marks of task 226.

## Findings

- Ghostty's `notify-on-command-finish` (off by default there) uses the
  prompt marks, with `notify-on-command-finish-after` defaulting to 5
  seconds and "unfocused" as the usual condition.
- Ghostty's parser reads the command line from OSC 133;C (`cmdline`,
  `cmdline_url`) and the status from D, but the stream drops the command
  line and the WASM handler ignored both.
- The core has no clock; the host reads output as it arrives, so it can time
  commands. Alerts (task 215) already reach paused and later browsers, are
  rate limited and become notices and system notifications.
- On this host `~/.zshrc` still has the README's hooks, so each command was
  marked twice and the second start, without a command line, replaced the
  first: the first live notice had no command.

## Changes

- `internal/terminalcore/source/command_api.zig`,
  `scripts/patch-terminal-core.mjs`: the stream hands the command line to
  the handler; C and D queue events (kind, status, command line; 64 KiB at
  most); `tessera_command_read`. `internal/terminalcore/ghostty-vt.wasm`
  rebuilt (core
  `1b568bb2a9b0353aa5c19d8b0bd545377fb5e8fa091176485be311fa698268a9`);
  `web/vendor/terminal.js` rebuilt with it.
- `internal/terminalcore/core.go`: `CommandEvent`, `Commands`.
- `internal/terminal/commands.go`: a command runs from its start to its end
  at the times they were read; a second start before an end is the same
  command (first start kept, a command line filled in); an end with no
  start is ignored. One of at least 5 seconds ending while no browser has
  the pane focused becomes a `command` alert (`title`, `status`, `seconds`),
  rate limited like notifications. `attention.go`: the fields; a bell no
  longer hides any other unseen alert. `manager.go`: read after each write.
- `web/terminal-attention.mjs`: `command` alerts accepted; notices "Failed
  with exit status 2 after 4 min 12 s" or "Finished after 7 s" headed by the
  command line (or "Command finished" under the window's name);
  `[finished]`/`[failed]` in window lists; a bell keeps them.
  `web/app.js`: notices and system notifications for them, the icon's
  title, and **Settings → Terminal → Command finished notices** (this
  browser, on by default; off marks them seen).
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: start with a command line and end
  with a status; none of either; the printf form; 512 bytes on a character
  boundary; a command line used once; the queue bounded.
- `internal/terminal/commands_test.go` (`-race`): a long command in an
  unwatched pane becomes an alert for a paused browser, kept as unseen and
  not hidden by a bell; quick commands, a cancelled prompt and a command in
  a focused pane say nothing; no command line or status; marks sent twice.
- `web/terminal-attention.test.mjs`: accepting, wording by outcome and
  duration, labels, an unknown status not a failure, merging with bells,
  durations. `web/settings-modal.test.mjs`: both new settings shown.
- Full JavaScript suite: 751 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary, this account's zsh (with the old README hooks
  still in `~/.zshrc`), headless Chrome: `sleep 6; false` in one window
  while another was active gave the window a dot, `[failed]`, and the notice
  "sleep 6; false / Failed with exit status 1 after 6 s / Terminal 1";
  showing the window cleared it; `sleep 1` in another window gave nothing.
- Not yet tried on the iPad, or as a system notification.
