# Task 209: Follow the shell's working directory (OSC 7)

Status: complete (iPad check pending)

## Request

Implement OSC 7.

## Findings

- Panes already have a working directory: the field in the pane's status
  bar, picked with the directory browser. The server starts the shell there,
  new terminals take the active pane's, and shortcuts with a blank directory
  use it. It changed only when picked, so it went stale as soon as you `cd`.
- The core parsed OSC 7 and dropped it (`.report_pwd` among the no-op
  actions).
- zsh and bash on macOS send OSC 7 only in Terminal.app: `/etc/zshrc` sources
  `/etc/zshrc_$TERM_PROGRAM`, and only `zshrc_Apple_Terminal` reports.
- The server failed to start a shell whose directory was gone. With the
  directory following the shell, deleting the directory you were in and
  restarting the host would have left the pane unable to open.

## Changes

- `internal/terminalcore/source/pwd_api.zig`, `scripts/patch-terminal-core.mjs`:
  the response handler keeps the last non-empty OSC 7 report of at most
  8 KiB, as sent, with a revision. `tessera_pwd_revision`, `tessera_pwd_length`
  and `tessera_pwd_data` read it. Not part of snapshots: the pane saves the
  directory itself. `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `1aec731907a33ff4f232093da79ccf76ff1e4ed87a8f98a2f6d1165be5984fc0`, with
  task 210).
- `web/terminal-entry.js`: after each write, a new report reaches
  `onWorkingDirectoryChange` listeners, once per write, even when it repeats
  the directory. Reset and snapshot restore start over.
- `web/terminal-working-directory.mjs` (embedded, `web/embed.go`):
  `terminalWorkingDirectory(report, hostName)` gives the decoded path of a
  `file:` URL whose host is empty, `localhost`, a loopback address, or the
  Tessera host (whole name or first label: `studio` and `studio.local`
  match), and "" for another machine, another scheme, a malformed escape,
  control characters or over 4096 characters. `file:///C:/...` gives `C:/...`.
- `internal/httpapi/terminal.go`: the attach message carries `host`, from
  `os.Hostname()` on each attach.
- `web/app.js`: keeps the host name from the attach message, and sets the
  pane's directory from each report that passes (saved with the workspace,
  shown in the field).
- `internal/terminal/session.go`: a missing directory, or one that isn't a
  directory, starts the shell in the host default.
- `~/.zshrc`: a `chpwd` hook sending OSC 7, percent-encoding everything but
  unreserved path characters byte by byte, and one report at startup.
- `web/vendor/terminal.js` rebuilt. `README.md` (with the zsh hook),
  `CHANGELOG.md`, `docs/terminal-core.md`.

## Validation

- `internal/terminalcore/core.test.mjs`: the report survives every byte split;
  empty and oversized reports leave the last one; a repeated report still
  bumps the revision; other OSCs and text don't touch it.
- `web/terminal-entry.test.mjs`, real core: one report per write, the last;
  listeners stop on dispose; a restored snapshot reports nothing of its own.
- `web/terminal-working-directory.test.mjs`: host matching, decoding
  (spaces, encoded and not, UTF-8), Windows drive paths, rejections.
- `internal/terminal`: `Start` in a removed directory and in `/dev/null`
  starts the shell in the default (fails without the change).
  `internal/httpapi`: the attach message names the host.
- Full JavaScript suite: 688 pass. `go test ./...` fails only on the
  unembedded `screensaver.mjs`, as before. `npm run verify:terminal-core`
  reproduces the core.
- The zsh hook in `My Dir #1/café` sends
  `file://outerhaven.local/.../My%20Dir%20%231/caf%C3%A9`, which the parser
  decodes back.
- Real host, the real zsh with the hook, headless Chrome over the DevTools
  protocol, fresh workspace: a terminal that ran `cd` into that directory
  showed it in its field; a second terminal opened from it started there
  (its own startup report agreed); after the host restarted and the page
  reloaded, both panes kept it and their new shells started there. No page
  errors.
- Not yet tried on the iPad.
