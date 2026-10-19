# Task 221: Synchronized output

Status: complete (iPad check pending)

## Request

Support synchronized output (mode 2026), so a program's redraw is shown
whole instead of half drawn.

## Findings

- The core tracks mode 2026 and snapshots carry it; Tessera reported it
  unrecognised (task 217) and left `Sync` out of XTGETTCAP (task 220)
  because nothing acted on it.
- Ghostty's renderer skips every frame while the mode is on. Starting it
  sets a one-second timer that turns the mode off, and a resize turns it
  off (`termio/Thread.zig`, `Termio.zig`, `renderer/generic.zig`).
- In Tessera only the browser paints, from its own core, which reads the
  same output. A redraw reaches it in many pieces: the macOS PTY gives about
  1 KiB per read, each read is an output message, and the browser applies
  messages in chunks of at most 16 KiB per turn. The render scheduler's
  quiet-time coalescing (3 ms quiet, at most 16 ms) keeps most paints whole
  when output is fast, but not when a redraw takes longer to arrive.
- A frame only sees the mode between writes. Redraws arriving back to back
  could find it on at every frame, so a hold has to be limited by time
  rather than restarted by each redraw, or nothing would ever be painted.
- Turning the mode off on a timeout, as Ghostty does, would make the
  browser's core disagree with the host's, which answers DECRQM and
  provides snapshots. Task 222 does it in both, through the host.

## Changes

- `web/terminal-entry.js`: `holdingSynchronizedOutput()`; the render frame
  paints nothing while the core has mode 2026 on, keeping a pending full
  redraw and leaving the output unacknowledged in output timing. A hold
  lasts at most `synchronizedOutputTimeoutMs` (one second); after that,
  painting goes on as usual until a frame finds the mode off. The write
  that ends the mode asks for the paint, as any output does.
- `scripts/patch-terminal-core.mjs`: DECRQM reports 2026 from the mode
  table; XTGETTCAP answers `Sync`; `ghostty_terminal_resize` turns the mode
  off when the size changes, in the host's core and the browsers' alike.
- `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `25a02bf2939986e4956da9403c3daad248779568979f505359352c7f5a3ec4cd`; rebuilt
  again in task 222);
  `web/vendor/terminal.js` rebuilt with it.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`; notes in tasks 217
  and 220.

## Validation

- `internal/terminalcore/core.test.mjs`: DECRQM for 2026 off and on, kept
  by a snapshot, unchanged by a same-size resize, ended by a resize;
  XTGETTCAP `Sync`.
- `web/terminal-entry.test.mjs`, with the real core: held mid-redraw with
  one timer, released when the redraw ends; the timeout asks for a paint
  and painting continues while the mode stays on; held again after a frame
  finds it off; a redraw ending and the next starting in one write keeps
  the first timer; a resize ends the hold. A held frame draws nothing and
  doesn't count as shown, and the next frame does the full redraw asked for
  meanwhile.
- Full JavaScript suite: 732 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome, a maximized terminal, a program drawing full-screen
  redraws (each row's first letter names its redraw) in mode 2026. A probe
  on the renderer checked at each paint whether the rows came from more than
  one redraw:
  - each redraw sent at once (55 KB, about 56 messages): coalescing kept
    paints whole with or without the hold;
  - each redraw sent in four parts 20 ms apart, as over a slow link: with
    the hold disabled, 106 of 141 paints mixed two redraws; with it, 0 of
    38, about one paint per redraw.

  No page errors.
- Not yet tried on the iPad, or with Neovim or tmux (not installed here).
