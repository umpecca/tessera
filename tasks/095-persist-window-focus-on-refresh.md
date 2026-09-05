# Task 095: Preserve window focus across refresh

Status: complete

Investigate and fix the last focused window changing after page refresh.
Preserve the saved selection while terminal panes initialize asynchronously,
and retain normal focus changes after initialization.

The terminal library synchronously focuses its input in `open()`. The pane's
`focusin` listener then selects and raises that terminal, replacing the restored
active pane before the previous focus-restoration check can run.

Suppress propagation of startup focus events while opening the terminal and
restore the previously focused control afterward, including on startup failure.

Verification:
- `node --test web/*.test.mjs`: 175 tests passed, including startup focus
  preservation, normal subsequent selection, and failure cleanup.
- `node --check web/app.js`: passed.
- `npm run build:web`: passed.
- `git diff --check`: passed.

A live browser refresh was not exercised in this change.
