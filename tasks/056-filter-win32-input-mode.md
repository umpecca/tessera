# Task 056: Filter unsupported Win32 input mode

Status: deferred

The warning is intentionally retained for now. A future implementation should
support Win32 input mode rather than filtering its negotiation sequence.

Prevent Ghostty Web from logging an intermittent `unimplemented mode: 9001`
warning when Windows ConPTY emits its private Win32 input-mode control
sequence.

## Background

Windows ConPTY emits `CSI ? 9001 h` and `CSI ? 9001 l` to enable and disable
Win32 input mode. Ghostty Web 0.4.0 does not implement this Windows-specific
mode and currently logs a warning before ignoring it. Tessera continues to
send VT-style keyboard input, so passing the sequence to Ghostty Web has no
functional effect.

## Requirements

- Remove only the exact Win32 input-mode set/reset sequences before terminal
  output reaches Ghostty Web.
- Handle sequences split across WebSocket message boundaries.
- Preserve all other terminal bytes exactly, including incomplete or similar
  control sequences that are not mode 9001.
- Do not suppress Ghostty Web logging globally or hide unrelated warnings.
- Keep the compatibility filter in Tessera-owned source rather than generated
  vendor code.
- Reset pending filter state when a terminal is disposed.

## Verification

- Add focused tests for complete, adjacent, split, malformed, and ordinary
  terminal output.
- Run all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.
