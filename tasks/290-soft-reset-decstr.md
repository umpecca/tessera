# Task 290: Soft reset (DECSTR, CSI ! p)

Status: implemented, awaiting a live check (2026-11-24).

## Request

Sweep item: the pinned parser ignores `CSI ! p`, so `tput init`/`tset` (terminfo is2/rs2) only partly reset. The user chose sweep items #1-#4 ("lets do #1, #2, #3, #4").

## Scope

- Parser: `CSI ! p` calls a Tessera handler hook (the @hasDecl pattern used for OSC 133 command lines).
- Handler: as xterm's DECSTR: cursor visible, insert and origin off, autowrap/cursor keys/keypad/keyboard lock back to defaults, margins to the whole screen, character sets to ASCII, attributes and protection off, saved cursor forgotten. Screen, cursor position and other modes stay.
- Built in one core rebuild with tasks 289-292 (one core ID change).
- Approval: the user chose this item from the listed sweep items.

## Acceptance criteria

- [x] After `CSI ! p`, those modes, margins and attributes are reset; text and cursor position are not.
- [x] `CSI $ p` (DECRQM) is unaffected.
- [x] Docs and CHANGELOG updated.

## Verification

- `internal/terminalcore/core.test.mjs`: new test, modes (4, 6, 25, 1, 66, 7),
  margins and attributes reset (CPR, DECRQSS m and r), ASCII after DEC line
  drawing, saved cursor forgotten, screen and cursor kept, other modes kept,
  DECRQM still answered.
- Not tested with `tput init` live (pending, user).
- One core rebuild for tasks 289-292: `ZIG=$(brew --prefix zig@0.15)/bin/zig npm run build:terminal-core`,
  core `4905925479f658c48b66a58b60eb8c3195c3a1b203f95382be78f552b74cd288`;
  `--check` matches. The first build failed: the new `CSI ! p` parser text has
  a `'$'` literal, which `String.replace` read as a `$'` pattern; added
  `spliceOnce` (literal split/join) to `scripts/patch-terminal-core.mjs` for it.
- `node --test web/*.test.mjs internal/terminalcore/core.test.mjs`: 1165/1165;
  `go test ./...`: pass; `go vet ./internal/terminalcore/ ./internal/terminal/ ./web/`:
  clean; `npm run build:web`: succeeded.

## Implementation notes

- `scripts/patch-terminal-core.mjs`: `CSI ! p` in `src/terminal/stream.zig`
  calls `softReset` via `@hasDecl`; `softReset` on the response handler (and a
  forwarder on `ImageResponseHandler`) in `src/terminal/c/terminal.zig`.
- Autowrap goes back to its default (on), as Ghostty's mode table has it; the
  VT510 manual's DECSTR turns autowrap off. Cursor style and the mouse modes
  are not reset (not part of DECSTR).
- Docs: `docs/terminal.md`, `docs/terminal-core.md`; `CHANGELOG.md`.
