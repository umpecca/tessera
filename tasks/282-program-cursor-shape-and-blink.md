# Task 282: Cursor shape and blink set by programs

Status: implemented, awaiting a visual check in a browser (2026-11-24).

## Request

Item #3 from the mode review after task 279: programs set the cursor shape
and blink with DECSCUSR (`CSI Ps SP q`) and mode 12, such as Neovim's bar
cursor in insert mode, but Tessera always draws the cursor from its own
settings. The user said "lets do #3 next" and chose to install Zig and
rebuild the core rather than track the sequence in the browser.

## Scope

- Install Homebrew `zig@0.15` (0.15.2, keg-only), the pinned toolchain in
  `internal/terminalcore/source.json`. Approved by the user.
- Core: a new export reporting the active cursor shape and blink, which
  snapshots already carry (`cursor_style`), so it survives reconnects.
- Browser: draw the cursor in that shape and blink it as the program asked,
  and go back to the pane's settings when the program resets to default
  (`CSI 0 SP q`) or the terminal is reset.
- Rebuild `internal/terminalcore/ghostty-vt.wasm` and `web/vendor/terminal.js`.
  The core ID changes, so open browsers must reload once.
- Approval: the user chose "Install Zig, rebuild core" for this item.

## Acceptance criteria

- [x] `CSI 5 SP q` and `CSI 6 SP q` draw a bar, 3/4 an underline, 1/2 a block;
      odd numbers blink, even ones don't.
- [x] `CSI 0 SP q` and a full reset restore the pane's own cursor settings.
- [x] The style survives a snapshot restore (reconnect).
- [x] Bundled core matches its source build (`npm run build:terminal-core -- --check`).
- [x] Docs and CHANGELOG updated.

## Verification

- Baseline before any change: `ZIG=$(brew --prefix zig@0.15)/bin/zig node scripts/build-terminal-core.mjs --check`
  reproduced the bundled core exactly (Zig 0.15.2 from Homebrew `zig@0.15`).
- `npm run build:terminal-core`: Zig sixel tests 6/6, new core
  `b31f2964d0d523ae8b903291220933856676cc72d93b708a2770da28b0de1824`;
  `--check` afterwards: bundled core matches its source build.
- `node --test internal/terminalcore/core.test.mjs`: 56/56, new test for
  every DECSCUSR value, mode 12 alone, DECRQSS, snapshots, `CSI 0 SP q`, RIS.
- `node --test web/terminal-entry.test.mjs`: new real-core test for shape,
  blink, the pane's blink setting, default, snapshot restore and reset.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1142/1142.
- `go test ./...`: all pass (snapshot magic `TSS4` in three tests);
  `go vet ./internal/terminalcore/ ./internal/terminal/`: clean.
- `npm run build:web`: succeeded; `tessera_cursor_style` is in `web/vendor/terminal.js`.
- Not checked in a browser (pending, user): Neovim insert mode, `printf '\e[5 q'`.

## Implementation notes

- Core: `internal/terminalcore/source/cursor_api.zig` (new,
  `tessera_cursor_style`); `scripts/patch-terminal-core.mjs` adds
  `cursor_default` to the response handler (cleared by DECSCUSR other than
  0, set by 0 and full reset) and the export;
  `internal/terminalcore/source/snapshot_api.zig` saves the flag, magic
  `TSS3` → `TSS4` (`source.json`, docs, Go tests).
- Mode 12 alone is ignored until a program sets a shape: xterm terminfo
  `cnorm` is `CSI ? 12 l CSI ? 25 h`, so honouring it would stop the blink
  after every ncurses program.
- Browser: `syncCursorStyle` in `web/terminal-entry.js` after writes, reset
  and snapshot restore; sets `renderer.cursorStyle` and the blink timer.
  Blink is the pane's setting (off in older-Mac mode) and the program's.
- The core ID changed; open browsers get "Terminal core changed; reload
  Tessera" once after the update.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
