# Task 060: Terminal clipboard shortcuts

Status: complete

Make terminal text selection and clipboard operations behave predictably in
Tessera, especially on macOS trackpads.

## Requirements

- Preserve the current terminal selection when opening Tessera's context menu
  with a secondary click.
- Copy selected terminal text with `Cmd+C` on macOS and `Ctrl+Shift+C` on
  other platforms.
- Paste into the terminal with `Cmd+V`, `Ctrl+Shift+V`, or `Shift+Insert`.
- Keep unmodified `Ctrl+C` available to the PTY for interrupting commands.
- Keep application mouse reporting intact when a terminal program has enabled
  it.
- Ensure context-menu Copy reads the selection before returning focus to the
  terminal.
- Document the supported terminal clipboard shortcuts.

## Verification

- Add focused tests for copy/paste shortcut recognition and modifier edge
  cases.
- Run all frontend tests, `node --check web/app.js`, `npm run build:web`,
  `go test ./...`, and `git diff --check`.

## Implementation

- Added `Cmd+C`/`Cmd+V` and `Ctrl+Shift+C`/`Ctrl+Shift+V` recognition alongside
  the existing `Shift+Insert` paste shortcut.
- Left unmodified `Ctrl+C` outside Tessera's clipboard handling so the PTY can
  continue using it as an interrupt.
- Cancelled local secondary-button pointer-down events before Ghostty Web can
  replace the active selection. Mouse-tracking applications still receive
  ordinary unmodified secondary-button reports.
- Removed terminal refocusing while opening the context menu and read selected
  text before restoring focus during Copy.
- Documented the supported shortcuts in the README and changelog.

## Verification results

- `node --test web/*.test.mjs` (53 tests passed)
- `node --check web/app.js`
- `node --check web/terminal-entry.js`
- `npm run build:web`
- `go test ./...`
- Real-browser smoke test: selection survived secondary click, context-menu
  Copy wrote the selected text, and `Ctrl+Shift+C`/`Ctrl+Shift+V` worked.
- `git diff --check`
