# Task 084: Keep macOS terminal Command-V out of the PTY

Status: complete (macOS Chrome retest pending)

In Chrome on macOS, copying a Fresh selection with `Ctrl+C` correctly reaches
the system clipboard through OSC 52, but pressing `Cmd+V` in Claude Code can
insert a literal `v`. The same clipboard content pastes correctly into native
macOS applications, and Tessera's `Ctrl+Shift+V` and terminal context-menu
Paste both paste the full text. Windows Edge `Ctrl+C`/`Ctrl+V` also works.

## Requirements

- Intercept only the macOS terminal `Cmd+V` keydown before a terminal program
  can receive a literal `v`.
- Do not cancel Chrome's default paste action; its paste event must continue
  through Tessera's existing bracketed-paste bridge.
- Leave Windows/Linux `Ctrl+V`, `Ctrl+Shift+V`, context-menu Paste, plain
  macOS `Ctrl+V`, and OSC 52 copying unchanged.
- Add regression coverage for the platform and modifier boundaries.

## Verification

- `node --test web/terminal-keyboard.test.mjs web/terminal-input.test.mjs`
  (25 tests passed)
- `node --test web/*.test.mjs` (141 tests passed)
- `node --check web/app.js`, `node --check web/terminal-keyboard.mjs`
- `go test ./...`
- `npm run build:web`
- Existing real-browser baseline supplied by the operator: Windows Edge
  `Ctrl+C`/`Ctrl+V`, macOS Chrome `Ctrl+Shift+V`, and terminal context-menu
  Paste all work. A macOS Chrome `Cmd+V` retest is still required because a
  synthetic keyboard event cannot trigger a trusted operating-system paste.
