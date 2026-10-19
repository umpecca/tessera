# Task 220: Capability and setting queries, in-band size reports

Status: complete (iPad check pending)

## Request

Answer capability and setting queries (XTGETTCAP, DECRQSS), which programs
such as Neovim use to find true colour and OSC 52 copying, and send in-band
size reports (mode 2048) when a pane resizes.

## Findings

- The WASM handler sends every DCS string to the Sixel decoder (task-era
  patch), so `DCS + q` and `DCS $ q` were dropped. Ghostty's own DCS parser
  (`dcs.zig`) reads both into commands, and Ghostty's app answers them
  (`termio/stream_handler.zig`): XTGETTCAP from its terminfo, generated at
  compile time, and DECRQSS for SGR, DECSCUSR, DECSTBM and DECSLRM.
- Ghostty's terminfo claims some things Tessera doesn't do: styled and
  coloured underlines (`Su`, `Smulx`, `Setulc`; ghostty-web draws one plain
  underline whatever the style or colour) and synchronized output (`Sync`;
  DECRQM reports 2026 unrecognised). Its `TN` is `xterm-ghostty`, while
  Tessera starts programs with the configured TERM (`xterm-256color` by
  default).
- Ghostty sends nothing for an unknown name; xterm, kitty and foot answer
  `DCS 0 + r name ST`, so a program needn't wait for a timeout.
- The core tracked mode 2048 but nothing sent reports. Ghostty sends one
  when the mode is enabled and after each resize. The host resizes the core
  and then sets its cell size (`tessera_sixel_geometry`), which is where the
  pixel size is known.

## Changes

- `scripts/patch-terminal-core.mjs`: DCS strings that aren't Sixel go to
  Ghostty's DCS parser (at most 4 KiB; reset at each new string and on
  CAN/SUB). XTGETTCAP answers each name in order from Ghostty's terminfo,
  without `Su`, `Smulx`, `Setulc` and `Sync`, with `TN` the host's TERM and
  `DCS 0 + r` for unknown names. DECRQSS as Ghostty answers it. Enabling
  2048 sends a report. DECRQM reports 2048 from the mode table.
- `internal/terminalcore/source/query_api.zig`: `tessera_set_term_name`.
- `internal/terminalcore/source/sixel_api.zig`: `sixel_geometry` sends a
  report while 2048 is on, if the size differs from the last one sent.
- `internal/terminalcore/ghostty-vt.wasm` rebuilt (core
  `0b04713109b0518e98401915cc1c5580ade2d7cbf04282efc1a419daca429374`);
  `web/vendor/terminal.js` rebuilt with it.
- `internal/terminalcore/core.go`: `SetTermName`; `setVersion` shares its
  string helper.
- `internal/terminal/manager.go`: a new session's core is given its TERM.
- `internal/terminal/state.go`: `ResizeWithMetrics` writes the core's
  replies (size reports) to the PTY after resizing it, outside the lock.
- `README.md`, `CHANGELOG.md`, `docs/terminal-core.md`; task 217's DECRQM
  note.

## Validation

- `internal/terminalcore/core.test.mjs`:
  - XTGETTCAP: `TN` before and after the host sets it, and a refused name;
    `Tc`, `RGB`, `Co`, `colors` in the order asked; lower-case hex; `kbs`,
    `Ms`, `fullkbd`; `Smulx`, `Setulc`, `Su`, `Sync` and an unknown name
    answered not found; an oversized query and a cancelled one unanswered;
    Sixel still drawing after a query.
  - DECRQSS: SGR plain, with attributes, with true colour; scrolling region;
    cursor style; left and right margins with and without DECLRMM; an
    unknown setting.
  - Mode 2048: DECRQM off and on; nothing before it's on; a report on
    enabling and after resizes; none for an unchanged size; one for a new
    cell size; kept through a snapshot; none after it's turned off.
  - DECRQM's list of modes reported unrecognised no longer has 2048.
- `internal/terminal/progress_test.go`: queries and size reports reach the
  PTY, one report per real resize. `-race`.
- Full JavaScript suite: 729 pass. `go test ./...` passes. `npm run
  verify:terminal-core` reproduces the core.
- Real host, a built binary serving its embedded files, the real zsh,
  headless Chrome, a raw-mode program that queried and enabled 2048. It got:
  - `TN` as `xterm-256color`; `Tc`, `RGB=8`, `Ms` and `fullkbd` found;
    `Smulx` and `Sync` not found;
  - `DCS 1 $ r 0;48:2::1:2:3m ST` after setting a true-colour background,
    and the cursor style `2 q`;
  - `CSI 48;17;68;323;612t` on enabling, then `CSI 48;36;131;684;1179t`
    after maximizing the window, and `CSI 48;30;98;570;882t` after the
    browser window shrank.

  No page errors.
- Not yet tried on the iPad, or with Neovim (not installed here).
