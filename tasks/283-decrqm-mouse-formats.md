# Task 283: Answer DECRQM for mouse formats 1005, 1015 and 1016

Status: complete (2026-11-24).

## Request

Follow-up from tasks 279 and 280: Tessera now acts on mouse formats 1005,
1015 and 1016, but the core still answers DECRQM (`CSI ? mode $ p`) for them
with 0 (not recognised). The user chose to fix this in the same core rebuild
as task 282.

## Scope

- `scripts/patch-terminal-core.mjs`: report 1005, 1015 and 1016 from the mode
  table (1 set, 2 reset), like every other mode.
- Update `internal/terminalcore/core.test.mjs` and docs.
- Built together with task 282 (one core ID change).
- Approval: the user chose "Yes, same rebuild".

## Acceptance criteria

- [x] `CSI ? 1016 $ p` answers `CSI ? 1016 ; 2 $ y`, and `; 1 $ y` after
      `CSI ? 1016 h`; likewise 1005 and 1015.
- [x] Docs no longer say these are answered as unrecognised.

## Verification

- `node --test internal/terminalcore/core.test.mjs`: 56/56; the DECRQM test
  now expects `;2$y` for 1005, 1015 and 1016 when reset and `;1$y` when set.
- Built with task 282; `node scripts/build-terminal-core.mjs --check` passes.
- Live check (2026-11-24), headless Chromium 158 driven by Playwright over CDP against a test instance (127.0.0.1:7400, `-web web/`, zsh), bytes logged by a raw-mode probe: DECRQM answered for 1016, 1007 (1), 9, 5, 1005, 1015, 12.

## Implementation notes

- `reportMode` in `scripts/patch-terminal-core.mjs` reports every mode from
  the table. Docs updated in `docs/terminal.md` and `docs/terminal-core.md`.
