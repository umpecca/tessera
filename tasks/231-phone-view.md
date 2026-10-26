# Task 231: Phone view

Status: complete (iPhone check pending)

## Request

Make Tessera usable from a phone for checking in on running work: see
which terminals exist and what they are doing, and open one to read or
type. Start with the most basic direct access; push notifications, new-task
launching and pairing come later. Tasks 232 (input) and 233 (viewing
without resizing) build on this one.

## Findings

- The workspace is a windowed desktop: draggable panes, 32px title bars
  (48px under `pointer: coarse`), Deskbar, command button. At phone widths
  (~360–430 CSS px) a single maximized pane is the only layout that works,
  and even that keeps desktop chrome.
- Terminal sessions are keyed by workspace and pane
  (`Manager.Attach(workspaceID, paneID, ...)`); there was no endpoint that
  listed running terminals with their state. Titles (OSC 0/2) are kept by
  the browser and saved with the pane; progress, alerts (`attention.go`)
  and the running command (`commands.go`) live on the host, and the host's
  core keeps the OSC 7 directory (`tessera_pwd_*`).
- The pinned core already exports what a text summary needs, so no core
  rebuild: `ghostty_render_state_get_viewport` (16-byte cells: codepoint,
  colours, flags, width 0 for a wide character's second half, grapheme
  length), `ghostty_render_state_get_grapheme`, and `tessera_semantic_rows`
  with the cursor row for "at a prompt".
- The host only learned a shell marks prompts from command start/end
  (OSC 133 C/D), so a fresh shell at its first prompt looked unmarked. The
  cursor row's mark answers that.
- Fits are explicit (`requestTerminalFit`), not observed, and
  `updateTerminalRenderState` decides which terminals' output is paused, so
  the phone view can show one pane fixed to the screen and pause the rest
  without touching saved geometry.
- Saves are compare-and-replace on a revision (task 050). With the desk's
  browser still open, the phone's copy goes stale: opening a terminal used
  to save `activePaneId` and could be refused, and a window opened at the
  desk never appeared on the phone. Found by the browser check below.

## Changes

- `internal/terminalcore/screen.go`: `ScreenText` (visible rows as text,
  graphemes and wide characters included, trailing blanks trimmed),
  `WorkingDirectory` (last OSC 7 URL), `AtPrompt` (cursor on a prompt,
  continuation or input row).
- `internal/terminal/summary.go`: `Summary` and `Manager.Summaries`:
  running command and how long, last command's line/status/duration,
  whether the shell marks prompts (including a shell at its first prompt),
  progress, unseen alert, directory (path from the file URL), the last
  three non-blank rows (240 bytes each, cut on a character boundary), how
  long since output, exited, size. `commands.go` keeps the last command's
  result; `manager.go` records the time of the last output.
- `internal/httpapi/terminal_summaries.go`: `GET
  /api/workspace/{id}/terminals`, routed in `workspace.go` behind the same
  session check. With `?version=` it answers when the summaries change, or
  after 25 s with the same version, checking once a second; the version
  leaves out the per-second clocks so an idle list stays quiet. Response
  has the host account's home folder for shortening paths.
- `web/phone-view.mjs`: view choice (`/m`, per-browser choice, otherwise a
  coarse pointer under 600 px), card status wording and order (unseen
  alerts, then running, then latest output), path shortening, and
  `PhoneView`: the list, the open terminal's header and `⋯` menu (Interrupt,
  Rename, Close), and one long-poll request at a time (dropped while the
  page is hidden, retried with backoff on failure). It reports when the
  host's shells and the page's panes disagree, once per difference and
  only while the list is showing.
- `web/app.js`: creates the view early (hooks run before the rest of the
  module is set up); `updatePhoneView` on startup, resize and pointer
  change; the open pane is the only unpaused, focused terminal; opening uses
  `setActivePane(..., { save: false })`; leaving refits every terminal;
  notices open the card's terminal; `refreshPhoneWorkspace` loads the
  newest workspace on entering, on becoming visible, when shells and panes
  disagree, and before New, Rename and Close, saving this page's pending
  changes first; Phone View / Desktop View palette commands.
- `web/styles.css`: list, cards, header, menu and the open pane fixed below
  the header, from the theme's tokens; desktop chrome and corner notices
  hidden in the list.
- `web/embed.go`, `README.md` (Phone view), `CHANGELOG.md`,
  `ARCHITECTURE.md`.

## Departures from the plan

- Live updates are one long-poll request instead of a WebSocket: the same
  single connection and quiet idle list, with no new socket protocol.
- No pull to refresh: the list updates by itself.
- `/m` stores the phone choice for the browser and goes to `/`, so session
  routes keep working.

## Validation

- `internal/terminalcore/screen_test.go`: colours stripped, wide characters,
  a combining grapheme, scrolling and resizing, OSC 7, prompt rows through
  scrollback.
- `internal/terminal/summary_test.go` (`-race`): first prompt, a running
  command with directory and tail, a failed command and a notification,
  alert cleared when seen; one workspace's sessions, closed ones left out;
  tail cutting and file URLs.
- `internal/httpapi/terminal_summaries_test.go` (`-race`): real PTY and
  socket; summary with the shell's output, a wait that times out with the
  same version, a wait answered by new output, method check; version
  ignores clocks.
- `web/phone-view.test.mjs`: view choice, paths, wording for every state,
  order, pane/summary merging, polling (versions, hidden page, retry),
  open/back/menu, a pane closed under the open terminal, session reset,
  shell/pane mismatch reporting. Harnesses in `command-wheel`,
  `retired-audio`, `startup`, `terminal-hidden-output` and
  `terminal-size-refresh` tests stub the view.
- Full JavaScript suite: 779 pass. `go test ./...` and `go vet ./...`
  pass. `git diff --check` clean.
- Real host, built binary, this account's zsh, headless Chrome (desktop
  1280×800 and phone 390×844 with touch): `echo desk-ready; sleep 8; false`
  at the desk showed as running with its output on the phone, then failed
  (exit 1) after 8 s without a reload; a fresh shell read "At the prompt";
  opening a card showed only that terminal below the header, typing ran
  there and reached the host's summary; the menu offered Interrupt, Rename,
  Close; the desk's window geometry and stacking were unchanged; a window
  opened at the desk appeared on the phone; **+** opened a new terminal and
  **Close…** ended it with no conflict; **Desktop** and `/m` switched views.
- Not yet tried on an iPhone (Safari or Home Screen app) or over Tailscale.

## Not done

- The phone takes the shell's size while it types (task 233).
- Input beyond the phone keyboard (task 232).
- A desktop browser left open offers to reload after the phone adds, renames
  or closes a window, as for any two browsers (task 050).
