# Task 217: Progress bar, mode and version queries, title stack

Status: complete (iPad check pending)

## Request

A progress bar on the title bar for OSC 9;4, answers to DECRQM and
XTVERSION, and Vim's title going away when you quit it (CSI 22/23 t).

## Findings

- The core parses all four (`progress_report`, `request_mode`,
  `request_mode_unknown`, `xtversion`, `title_push`, `title_pop`); the WASM
  handler dropped them.
- Ghostty answers DECRQM from its mode table. Tessera's core tracks modes it
  doesn't act on: the browser always sends SGR mouse reports whatever format
  is set, ghostty-web's renderer has no synchronized output, and nothing
  sends in-band size reports. A program told those are supported would rely
  on them.
- Upstream's parser reads only DEC mode queries (`CSI ? n $ p`); its branch
  for ANSI modes (`CSI n $ p`) sits under the two-intermediate case and can
  never run.
- Ghostty takes CSI 22/23 t only with a target of 0 or 2 (so Vim's icon-title
  `22;1t` is ignored) and leaves the stack unimplemented. Vim with
  `set title` sends `22;2t`, its own title, "Thanks for flying Vim" on exit,
  then `23;2t`.
- A shell like this zsh sets no title, so the title Vim saves is empty and
  popping it gives no title, which the pane ignored. Panes don't store their
  name from before a program titled them, and saving it would need a new
  workspace column.
- A browser restored from a snapshot runs its own core, so it needs the
  saved titles to pop the same one the host does.
- Ghostty's macOS app removes a progress report 15 seconds after the last.
  Windows whose output is paused (minimized, covered, hidden) get no output
  frames, so progress has to travel like alerts (task 215).

## Changes

- `internal/terminalcore/source/report_api.zig`,
  `scripts/patch-terminal-core.mjs`:
  - DECRQM: 1 set, 2 reset, 0 unknown, and 0 for modes 1005, 1015, 1016,
    2026 and 2048 (2048 is answered from the mode table since task 220). `stream.zig` patched so ANSI mode queries reach it.
  - XTVERSION: `DCS > | Tessera <version> ST`; `tessera_set_version`.
  - CSI 22/23 t: a ten-title stack; a full reset empties it.
  - OSC 9;4: `tessera_progress_revision`, `tessera_progress`.
- `internal/terminalcore/source/snapshot_api.zig`: snapshots carry the
  title stack. `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `1219468ad90cf1573d500fb3c73799ed5307f555e94d7a5382277d6e89457d22`; rebuilt
  again in task 219).
- `internal/terminalcore/core.go`: a new core is given the version (without
  a leading `v`); `Progress`.
- `internal/terminal/progress.go`, `manager.go`, `attention.go`: after each
  write a new report becomes a `terminal-progress` message (state name,
  percent or -1) for every attachment, latest only, woken with alerts.
  `CurrentProgress` for new connections, unless removed or 15 seconds old.
- `internal/httpapi/terminal.go`: progress goes out with alerts, and the
  current one when a connection starts.
- `web/terminal-progress.mjs` (embedded): reading messages, the bar's width
  and its description.
- `web/app.js`: a progress bar on each title bar (`role="progressbar"`),
  removed 15 seconds after the last report. When a program's title goes away
  (popped to none or reset), the pane gets back the name it had before
  programs titled it in this page; a name typed since is kept. After a
  reload with a program's title showing, that name isn't known and the title
  stays. `web/terminal-entry.js` reports a title going away once.
  `web/styles.css`: the bar, red for errors, amber when paused, a moving
  segment when busy (full and still under reduced motion).
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: DECRQM for DEC and ANSI modes, set
  and reset, the modes reported unrecognised, unknown modes; XTVERSION with
  and without a version, rejected versions; progress states, missing and
  clamped percentages, revisions; the title stack through pops to none, an
  empty stack, a snapshot, other targets, a bare `CSI 22 t`, the ten-entry
  limit and a full reset.
- `internal/terminal/progress_test.go`: progress reaches paused attachments,
  latest only; output without a report sends none; expiry and removal; the
  replies reach the PTY. `-race`.
- `web/terminal-progress.test.mjs`, `web/terminal-entry.test.mjs` (title
  going away after a pop and after RIS, once), `web/terminal-title.test.mjs`
  (the pane's own name back, a hand-typed name kept, not while renaming).
- Full JavaScript suite: 718 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files (no `-web`), the real
  zsh, headless Chrome:
  - Queries from a raw-mode program got `ESC[?2004;2$y`, `ESC[?2026;0$y`,
    `ESC[4;2$y` and `ESCP>|Tessera devESC\`.
  - `vim --clean -c "set title"` titled the window "[No Name] - VIM", and
    after `:q` it was "Terminal 1" again.
  - `printf '\e]9;4;1;40\a'` showed a bar at 40%; states 3, 2 and 0 showed a
    moving segment, a full red bar, and nothing.
  - A report sent while the window was minimized showed when it was
    restored.
  - No page errors.
- Not yet tried on the iPad.
