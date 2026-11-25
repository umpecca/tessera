# Task 289: xterm modifyOtherKeys (CSI > 4 ; 2 m)

Status: implemented, awaiting a live check (2026-11-24).

## Request

Sweep item: vim 9, Emacs and tmux ask for xterm's modifyOtherKeys to tell keys like Ctrl+Enter apart. The core records `CSI > 4 ; 2 m` (`flags.modify_other_keys_2`, carried by snapshots) but the browser never encodes with it. The user chose sweep items #1-#4 ("lets do #1, #2, #3, #4").

## Scope

- Core export of the modifyOtherKeys state 2 flag.
- Browser: while it is set (and no Kitty flags), every key goes through Ghostty's encoder, as the Kitty path does, with its modifyOtherKeys option on; `encodeKeyEvent` sets that option from the core.
- Built in one core rebuild with tasks 289-292 (one core ID change).
- Approval: the user chose this item from the listed sweep items.

## Acceptance criteria

- [x] With `CSI > 4 ; 2 m`, Ctrl+Enter and similar get Ghostty's `CSI 27 ; m ; code ~` sequences.
- [x] `CSI > 4 m` / reset returns to ordinary encoding.
- [x] Survives a snapshot (flags are in snapshots).
- [x] Docs and CHANGELOG updated.

## Verification

- `internal/terminalcore/core.test.mjs`: new test, the flag for `CSI > 4 ; 2 m`,
  not for level 1, cleared by `CSI > 4 m` and RIS, carried by a snapshot.
- `web/terminal-entry.test.mjs`: real core, Alt+Enter is `ESC \r`, then
  `CSI 27 ; 3 ; 13 ~` under level 2, plain text stays text, and back.
- Not tested: the keydown wiring in `web/terminal-view.mjs` (no harness);
  vim 9, Emacs or tmux live (pending, user).
- One core rebuild for tasks 289-292: `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`,
  core `4905925479f658c48b66a58b60eb8c3195c3a1b203f95382be78f552b74cd288`;
  `--check` matches. The first build failed: the new `CSI ! p` parser text has
  a `'$'` literal, which `String.replace` read as a `$'` pattern; added
  `spliceOnce` (literal split/join) to `scripts/patch-terminal-core.mjs` for it.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1165/1165;
  `go test ./...`: pass; `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`:
  clean; `npm run build:web`: succeeded.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: with `CSI >4;2m`: Ctrl+Enter `CSI 27;5;13~`, Alt+Enter `CSI 27;3;13~`, Shift+Enter `CSI 27;2;13~`, Ctrl+Tab `CSI 27;5;9~`, Ctrl+, and Ctrl+. `CSI 27;5;44~`/`46~`; Ctrl+1 `1` (Ghostty's ctrlSeq table, same as Ghostty); after `CSI >4m` Alt+Enter is `ESC CR`. Ctrl+; is Tessera's Session List shortcut. Ctrl+Shift+a gave `^A`; not compared with Ghostty (Playwright's key text may differ from a real keyboard).

## Implementation notes

- Core: `modify_other_keys` in `internal/terminalcore/source/report_api.zig`,
  exported as `tessera_modify_other_keys`.
- Browser: `modifyOtherKeys()` and option 4 in `encodeKeyEvent`
  (`web/terminal-entry.js`); the Kitty branch in `web/terminal-view.mjs` also
  runs while it is set (releases stay Kitty-only).
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
