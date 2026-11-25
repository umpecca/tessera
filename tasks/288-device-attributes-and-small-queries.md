# Task 288: Answer secondary/tertiary device attributes, CSI ? 6 n and CSI 19 t

Status: implemented, awaiting a check with vim or Emacs (2026-11-24).

## Request

From the escape-sequence sweep: the core leaves `CSI > c` (DA2), `CSI = c`
(DA3), `CSI ? 6 n` (DECXCPR) and `CSI 19 t` unanswered (checked by sending
them to `internal/terminalcore/ghostty-vt.wasm`). Vim and Emacs ask for DA2 at
startup. The user chose "#1 + two small queries".

## Findings

- `.device_attributes` in the patched `src/terminal/c/terminal.zig` answered
  only `.primary` (`CSI ? 62 ; 4 c`).
- Ghostty's app (`src/termio/stream_handler.zig`) answers DA2 with
  `CSI > 1 ; 10 ; 0 c` and leaves DA3 unanswered ("unimplemented").
- The pinned parser drops `CSI ? 6 n` (its `device_status` table has only 5,
  6 and ?996) and `CSI 19 t` (`size_report` covers 14, 16, 18 and 21) before
  the handler, so Ghostty's app doesn't answer them either.

## Scope

- DA2 as Ghostty's app; DA3 (`DCS ! | 00000000 ST`), DECXCPR
  (`CSI ? row ; col ; 1 R`) and `CSI 19 t` (`CSI 9 ; rows ; cols t`) as
  xterm, since Ghostty has no answer for them and the user asked for them.
- One core rebuild; the core ID changes (one browser reload).
- Approval: the user chose "#1 + two small queries" from the sweep list,
  which named exactly these four queries.

## Acceptance criteria

- [x] `CSI > c` and `CSI > 0 c` answer `CSI > 1 ; 10 ; 0 c`.
- [x] `CSI = c` is answered (xterm's form; Ghostty's app does not answer it).
- [x] `CSI ? 6 n` and `CSI 19 t` are answered.
- [x] Bundled core matches its source build (`--check`); tests pass.
- [x] Docs and CHANGELOG updated.

## Verification

- `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`: Zig
  sixel tests 6/6, new core
  `ce376951ab66439946dfe14c43ea472623a2d8b5a7188445f8dbdd4e82627f3b`;
  `--check` afterwards matches.
- Query probe against the new core: DA1 unchanged, DA2 `CSI > 1 ; 10 ; 0 c`
  (also for `CSI > 0 c`), DA3 `DCS ! | 00000000 ST`, `CSI ? 6 n`
  `CSI ? 1 ; 1 ; 1 R`, `CSI 19 t` `CSI 9 ; 24 ; 80 t`; `CSI 21 t` still
  unanswered.
- `node --test internal/terminalcore/core.test.mjs`: 57/57, new test for all
  four, origin mode and an extra parameter.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1156/1156.
- `go test ./...`: first run failed `TestAppModuleImportsAreEmbedded`
  (`terminal-selection-keys.mjs` from task 287 not embedded); fixed in
  `web/embed.go`, then all pass. `go vet ./web/`: clean.
- `npm run build:web`: succeeded.
- Not checked with vim or Emacs (pending, user).
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: DA2 `CSI >1;10;0c`, DA3 `DCS !|00000000 ST`, DECXCPR `CSI ?15;1;1R`, `CSI 19 t` `CSI 9;33;131t`.

## Implementation notes

- `scripts/patch-terminal-core.mjs`: a final step adds `extended_cursor_position`
  to `src/terminal/device_status.zig`, `csi_19_t` to `src/terminal/csi.zig`
  (appended, so other values keep their numbers), the `CSI 19 t` branch to
  `src/terminal/stream.zig`, and the answers in `src/terminal/c/terminal.zig`.
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
